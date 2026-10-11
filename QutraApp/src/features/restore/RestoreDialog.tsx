import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AppWindow,
  Globe,
  FileText,
  TerminalSquare,
  GitBranch,
  CircleCheck,
  CircleX,
  CircleAlert,
  Loader2,
  Clock,
  ShieldAlert,
  MinusCircle,
  Copy,
  ExternalLink,
} from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import { getBridge } from "@/lib/bridge";
import { getDb } from "@/lib/db/database";
import {
  createRestoreRun,
  finishRestoreRun,
} from "@/services/appService";
import type {
  RestoreItemResult,
  RestoreItemState,
  Snapshot,
  SnapshotItem,
} from "@/domain/types";
import type { MessageKey } from "@/lib/i18n/en";

const KIND_ICON: Record<SnapshotItem["kind"], typeof AppWindow> = {
  app: AppWindow,
  browser_tab: Globe,
  file: FileText,
  terminal: TerminalSquare,
  git: GitBranch,
  task: FileText,
  resource: Globe,
};

type Phase = "plan" | "running" | "done";

interface RestoreDialogProps {
  snapshot: Snapshot;
  open: boolean;
  onClose: () => void;
}

interface RowState {
  state: RestoreItemState;
  reason?: string;
}

function itemWarning(item: SnapshotItem, monitorChanged: boolean): MessageKey | null {
  if (item.target.includes("missing") || item.detail.includes("missing"))
    return "restore.warn.missingExe";
  if (item.target.includes("elevated") || item.detail.includes("admin"))
    return "restore.warn.elevation";
  if (monitorChanged && item.windowBounds) return "restore.warn.monitorChanged";
  return null;
}

function isRestorable(item: SnapshotItem): boolean {
  return item.provenance !== "simulated";
}

export function RestoreDialog({ snapshot, open, onClose }: RestoreDialogProps) {
  const { t } = useT();
  const { toast, announce } = useUi();
  const [phase, setPhase] = useState<Phase>("plan");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const bridge = getBridge();
  const simulated = bridge.mode === "browser";

  // Monitor topology comparison (browser demo reports a fixed topology).
  const [monitorChanged, setMonitorChanged] = useState(false);
  useEffect(() => {
    if (!open) return;
    void bridge.listMonitors().then((monitors) => {
      const changed =
        snapshot.monitors.length > 0 &&
        (monitors.length !== snapshot.monitors.length ||
          monitors.some(
            (m, i) =>
              snapshot.monitors[i] &&
              (m.width !== snapshot.monitors[i].width ||
                m.scale !== snapshot.monitors[i].scale),
          ));
      setMonitorChanged(changed);
    });
  }, [open, snapshot, bridge]);

  useEffect(() => {
    if (open) {
      setPhase("plan");
      setRows({});
      setRunId(null);
      setChecked(
        Object.fromEntries(
          snapshot.items.map((i) => [i.id, i.selected && isRestorable(i)]),
        ),
      );
    }
  }, [open, snapshot]);

  const selectedItems = useMemo(
    () => snapshot.items.filter((i) => checked[i.id] && isRestorable(i)),
    [snapshot.items, checked],
  );

  const start = (itemsToRun: SnapshotItem[]) => {
    setPhase("running");
    const initial: Record<string, RowState> = { ...rows };
    for (const item of itemsToRun) initial[item.id] = { state: "queued" };
    setRows(initial);
    const run = runId
      ? { id: runId }
      : createRestoreRun(snapshot, itemsToRun);
    if (!runId) setRunId(run.id);

    const results = new Map<string, RestoreItemResult>();
    for (const [itemId, row] of Object.entries(initial)) {
      results.set(itemId, { itemId, state: row.state, reason: row.reason });
    }

    const { cancel } = bridge.restoreItems(itemsToRun, (event) => {
      if (event.kind === "state") {
        const state = event.state as RestoreItemState;
        setRows((prev) => ({
          ...prev,
          [event.itemId]: { state, reason: event.reason },
        }));
        results.set(event.itemId, {
          itemId: event.itemId,
          state,
          reason: event.reason,
          finishedAt:
            state === "restored" || state === "failed" || state === "skipped"
              ? Date.now()
              : undefined,
        });
        if (state === "restored" || state === "failed") {
          announce(
            `${itemsToRun.find((i) => i.id === event.itemId)?.title ?? ""}: ${t(
              `restore.state.${state}` as MessageKey,
            )}`,
          );
        }
      } else {
        setPhase("done");
        const finalItems = [...results.values()];
        const failed = finalItems.filter(
          (r) => r.state === "failed" || r.state === "permission_required",
        ).length;
        const skipped = finalItems.filter((r) => r.state === "skipped").length;
        finishRestoreRun(
          run.id,
          event.status === "cancelled"
            ? "cancelled"
            : failed > 0
              ? "partial"
              : "completed",
          finalItems,
        );
        if (event.status !== "cancelled") {
          toast({
            kind: failed > 0 ? "info" : "success",
            message:
              failed > 0
                ? t("restore.partial", { failed, skipped })
                : t("restore.completed"),
          });
        }
      }
    });
    cancelRef.current = cancel;
  };

  const retryFailed = () => {
    const failedItems = snapshot.items.filter((i) => {
      const st = rows[i.id]?.state;
      return (
        isRestorable(i) &&
        (st === "failed" || st === "permission_required")
      );
    });
    if (failedItems.length > 0) start(failedItems);
  };

  const skipItem = (itemId: string) => {
    setRows((prev) => ({ ...prev, [itemId]: { state: "skipped" } }));
  };

  const doneCount = Object.values(rows).filter(
    (r) => r.state === "restored",
  ).length;
  const failedCount = Object.values(rows).filter(
    (r) => r.state === "failed" || r.state === "permission_required",
  ).length;
  const running = phase === "running";

  const stateBadge = (row: RowState | undefined) => {
    const state = row?.state ?? "queued";
    const map: Record<
      RestoreItemState,
      { icon: ReactNode; color: string }
    > = {
      queued: { icon: <Clock size={13} aria-hidden />, color: "var(--muted)" },
      launching: {
        icon: <Loader2 size={13} className="spin" aria-hidden />,
        color: "var(--info)",
      },
      waiting: {
        icon: <Loader2 size={13} className="spin" aria-hidden />,
        color: "var(--info)",
      },
      repositioning: {
        icon: <Loader2 size={13} className="spin" aria-hidden />,
        color: "var(--info)",
      },
      restored: {
        icon: <CircleCheck size={13} aria-hidden />,
        color: "var(--success)",
      },
      skipped: {
        icon: <MinusCircle size={13} aria-hidden />,
        color: "var(--muted)",
      },
      permission_required: {
        icon: <ShieldAlert size={13} aria-hidden />,
        color: "var(--warning)",
      },
      failed: {
        icon: <CircleX size={13} aria-hidden />,
        color: "var(--danger)",
      },
    };
    const entry = map[state];
    return (
      <span className="restore-state" style={{ color: entry.color }}>
        {entry.icon}
        {t(`restore.state.${state}` as MessageKey)}
        {row?.reason && state === "failed" && (
          <span className="faint">({row.reason})</span>
        )}
      </span>
    );
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (running) return; // cancel first
        onClose();
      }}
      title={`${t("restore.title")} — ${snapshot.name}`}
      wide
      preventClose={running}
      footer={
        phase === "plan" ? (
          <>
            <button type="button" className="btn btn--secondary" onClick={onClose}>
              {t("action.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={selectedItems.length === 0}
              onClick={() => start(selectedItems)}
            >
              {t("restore.start")} ({selectedItems.length})
            </button>
          </>
        ) : phase === "running" ? (
          <button
            type="button"
            className="btn btn--danger-outline"
            onClick={() => {
              cancelRef.current?.();
              setPhase("done");
            }}
          >
            {t("restore.cancel")}
          </button>
        ) : (
          <>
            {failedCount > 0 && (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={retryFailed}
              >
                {t("restore.retryFailed")} ({failedCount})
              </button>
            )}
            <button type="button" className="btn btn--primary" onClick={onClose}>
              {t("action.done")}
            </button>
          </>
        )
      }
    >
      {simulated && (
        <p
          className="muted"
          style={{
            fontSize: "var(--fs-12)",
            background: "var(--info-soft)",
            padding: "var(--sp-2) var(--sp-3)",
            borderRadius: "var(--r-2)",
            marginBottom: "var(--sp-3)",
          }}
        >
          {t("restore.simulated")}
        </p>
      )}

      {phase === "plan" && (
        <>
          <p className="muted" style={{ fontSize: "var(--fs-12)", marginBottom: "var(--sp-2)" }}>
            {t("restore.planHint")}
          </p>
          {snapshot.handoff && (
            <p
              style={{
                fontSize: "var(--fs-13)",
                borderLeft: "none",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--r-2)",
                padding: "var(--sp-2) var(--sp-3)",
                marginBottom: "var(--sp-3)",
              }}
            >
              “{snapshot.handoff}”
            </p>
          )}
        </>
      )}

      {phase !== "plan" && (
        <div style={{ marginBottom: "var(--sp-3)" }}>
          <div
            className="progress"
            role="progressbar"
            aria-valuenow={doneCount}
            aria-valuemin={0}
            aria-valuemax={selectedItems.length}
            aria-label={t("restore.progress", {
              done: doneCount,
              total: selectedItems.length,
            })}
          >
            <div
              style={{
                width: `${selectedItems.length ? (doneCount / selectedItems.length) * 100 : 0}%`,
              }}
            />
          </div>
          <p className="muted" style={{ fontSize: "var(--fs-12)", marginTop: 6 }} aria-live="polite">
            {t("restore.progress", {
              done: doneCount,
              total: selectedItems.length,
            })}
          </p>
        </div>
      )}

      <div className="panel panel-body--flush" style={{ padding: 0 }}>
        {snapshot.items.map((item) => {
          const Icon = KIND_ICON[item.kind];
          const warning = itemWarning(item, monitorChanged);
          const row = rows[item.id];
          const isChecked = checked[item.id] ?? false;
          const restorable = isRestorable(item);
          return (
            <div key={item.id} className="restore-row">
              {phase === "plan" ? (
                <input
                  id={`restore-item-${item.id}`}
                  type="checkbox"
                  checked={isChecked}
                  disabled={!restorable}
                  onChange={(e) =>
                    setChecked((c) => ({ ...c, [item.id]: e.target.checked }))
                  }
                  aria-label={`${item.title} — ${t(
                    `snapshot.provenance.${item.provenance ?? "legacy_unknown"}` as MessageKey,
                  )}`}
                />
              ) : (
                <Icon size={15} aria-hidden style={{ color: "var(--muted)" }} />
              )}
              <div style={{ minWidth: 0 }}>
                <div className="flex" style={{ gap: 6 }}>
                  {phase === "plan" && (
                    <Icon size={14} aria-hidden style={{ color: "var(--muted)", flex: "none" }} />
                  )}
                  {phase === "plan" ? (
                    <label
                      htmlFor={`restore-item-${item.id}`}
                      className="truncate"
                      style={{ fontWeight: 500 }}
                    >
                      {item.title}
                    </label>
                  ) : (
                    <span className="truncate" style={{ fontWeight: 500 }}>
                      {item.title}
                    </span>
                  )}
                </div>
                <div className="muted truncate" style={{ fontSize: "var(--fs-12)" }}>
                  {item.detail || item.target}
                </div>
                {warning && phase === "plan" && (
                  <div
                    className="flex"
                    style={{ gap: 4, fontSize: "var(--fs-12)", color: "var(--warning)" }}
                  >
                    <CircleAlert size={12} aria-hidden />
                    {t(warning)}
                  </div>
                )}
                {phase === "plan" && (
                  <div className="faint" style={{ fontSize: "var(--fs-12)" }}>
                    {t(
                      `snapshot.provenance.${item.provenance ?? "legacy_unknown"}` as MessageKey,
                    )}
                  </div>
                )}
              </div>
              <div>
                {phase !== "plan" && isChecked ? (
                  stateBadge(row)
                ) : phase === "plan" ? (
                  <span className="faint" style={{ fontSize: "var(--fs-12)" }}>
                    {t(`snapshot.kind.${item.kind}` as MessageKey)}
                  </span>
                ) : (
                  <span className="faint" style={{ fontSize: "var(--fs-12)" }}>
                    {t("restore.state.skipped")}
                  </span>
                )}
              </div>
              <div className="flex" style={{ gap: 2 }}>
                {phase === "done" &&
                  (row?.state === "failed" ||
                    row?.state === "permission_required") && (
                    <>
                      {item.target.startsWith("http") && (
                        <button
                          type="button"
                          className="btn btn--icon btn--sm"
                          aria-label={t("restore.openManually")}
                          title={t("restore.openManually")}
                          onClick={() => void bridge.openUrl(item.target)}
                        >
                          <ExternalLink size={13} aria-hidden />
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn--icon btn--sm"
                        aria-label={t("restore.copyCommand")}
                        title={t("restore.copyCommand")}
                        onClick={() => {
                          void bridge.writeClipboard(item.target);
                          toast({ kind: "info", messageKey: "toast.copied" });
                        }}
                      >
                        <Copy size={13} aria-hidden />
                      </button>
                    </>
                  )}
                {running && row?.state === "queued" && (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => skipItem(item.id)}
                  >
                    {t("restore.skipItem")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

/** Convenience: open a workspace's resume snapshot. */
export function useResumeSnapshot(workspaceId: string | undefined) {
  const db = getDb();
  if (!workspaceId) return undefined;
  const ws = db.collection("workspaces").get(workspaceId);
  if (!ws) return undefined;
  if (ws.resumeSnapshotId) {
    const snap = db.collection("snapshots").get(ws.resumeSnapshotId);
    if (snap) return snap;
  }
  return db
    .collection("snapshots")
    .getAll()
    .filter((s) => s.workspaceId === workspaceId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}
