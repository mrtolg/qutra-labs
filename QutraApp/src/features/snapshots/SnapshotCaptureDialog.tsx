import { useEffect, useState } from "react";
import {
  AppWindow,
  Globe,
  FileText,
  TerminalSquare,
  GitBranch,
  EyeOff,
} from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import {
  buildCaptureCandidates,
  captureSnapshot,
  type CaptureCandidate,
} from "@/services/appService";
import type { SnapshotItem } from "@/domain/types";
import type { MessageKey } from "@/lib/i18n/en";

const KIND_ICON: Record<string, typeof AppWindow> = {
  app: AppWindow,
  browser_tab: Globe,
  file: FileText,
  terminal: TerminalSquare,
  git: GitBranch,
};

interface SnapshotCaptureDialogProps {
  workspaceId: string;
  sessionId?: string;
  open: boolean;
  onClose: () => void;
  onCaptured?: (snapshotId: string) => void;
  defaultName?: string;
  defaultHandoff?: string;
}

export function SnapshotCaptureDialog({
  workspaceId,
  sessionId,
  open,
  onClose,
  onCaptured,
  defaultName,
  defaultHandoff,
}: SnapshotCaptureDialogProps) {
  const { t, locale } = useT();
  const { toast } = useUi();
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<CaptureCandidate[]>([]);
  const [excluded, setExcluded] = useState<CaptureCandidate[]>([]);
  const [name, setName] = useState("");
  const [handoff, setHandoff] = useState("");
  const [setAsResume, setSetAsResume] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setName(
      defaultName ??
        `${new Date().toLocaleDateString(locale)} ${new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`,
    );
    setHandoff(defaultHandoff ?? "");
    setSetAsResume(true);
    void buildCaptureCandidates(workspaceId).then((result) => {
      setCandidates(result.candidates);
      setExcluded(result.excluded);
      setLoading(false);
    });
  }, [open, workspaceId, defaultName, defaultHandoff, locale]);

  const toggle = (id: string) => {
    setCandidates((prev) =>
      prev.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c)),
    );
  };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const items: SnapshotItem[] = candidates.map(
      ({ excludedBy: _excludedBy, ...item }) => item,
    );
    const snap = await captureSnapshot({
      workspaceId,
      sessionId,
      name: name.trim(),
      handoff: handoff.trim(),
      items,
      setAsResume,
    });
    setSaving(false);
    toast({ kind: "success", messageKey: "snapshot.captured" });
    onCaptured?.(snap.id);
    onClose();
  };

  const selectedCount = candidates.filter((c) => c.selected).length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("snapshot.capture")}
      wide
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t("action.cancel")}
          </button>
          <button
            type="button"
            className={`btn btn--primary${saving ? " is-loading" : ""}`}
            disabled={!name.trim() || selectedCount === 0 || loading}
            onClick={() => void save()}
          >
            {t("snapshot.capture")} ({selectedCount})
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: "var(--sp-3)" }}>
        <div className="field">
          <label htmlFor="snap-name">{t("snapshot.name")}</label>
          <input
            id="snap-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="snap-handoff">
            {t("snapshot.handoff")}{" "}
            <span className="faint">({t("common.optional")})</span>
          </label>
          <textarea
            id="snap-handoff"
            className="textarea"
            rows={2}
            value={handoff}
            onChange={(e) => setHandoff(e.target.value)}
            placeholder={t("snapshot.handoffPlaceholder")}
          />
        </div>

        <p className="muted" style={{ fontSize: "var(--fs-12)" }}>
          {t("snapshot.review")}
        </p>

        {loading ? (
          <div className="stack">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton" style={{ height: 40 }} />
            ))}
          </div>
        ) : (
          <div className="panel" style={{ padding: 0 }}>
            {candidates.map((item) => {
              const Icon = KIND_ICON[item.kind] ?? FileText;
              return (
                <label
                  key={item.id}
                  className="restore-row"
                  style={{
                    cursor:
                      item.provenance === "simulated"
                        ? "not-allowed"
                        : "pointer",
                  }}
                >
                  <span className="sr-only">{item.title}</span>
                  <input
                    type="checkbox"
                    checked={item.selected}
                    disabled={item.provenance === "simulated"}
                    onChange={() => toggle(item.id)}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div className="flex" style={{ gap: 6 }}>
                      <Icon
                        size={14}
                        aria-hidden
                        style={{ color: "var(--muted)", flex: "none" }}
                      />
                      <span className="truncate" style={{ fontWeight: 500 }}>
                        {item.title}
                      </span>
                    </div>
                    <div className="muted truncate" style={{ fontSize: "var(--fs-12)" }}>
                      {item.detail || item.target}
                    </div>
                  </div>
                  <span
                    className="stack"
                    style={{ gap: 3, alignItems: "flex-end" }}
                  >
                    <span className="faint" style={{ fontSize: "var(--fs-12)" }}>
                      {t(`snapshot.kind.${item.kind}` as MessageKey)}
                    </span>
                    <span className="badge">
                      {t(
                        `snapshot.provenance.${item.provenance ?? "legacy_unknown"}` as MessageKey,
                      )}
                    </span>
                  </span>
                  <span />
                </label>
              );
            })}
          </div>
        )}

        {excluded.length > 0 && (
          <div>
            <div className="section-label flex" style={{ gap: 6 }}>
              <EyeOff size={13} aria-hidden />
              {t("snapshot.excluded")}
            </div>
            <div className="panel" style={{ padding: "var(--sp-2) var(--sp-3)" }}>
              {excluded.map((item) => (
                <div
                  key={item.id}
                  className="muted"
                  style={{ fontSize: "var(--fs-12)", padding: "2px 0" }}
                >
                  {item.title} — {item.excludedBy}
                </div>
              ))}
            </div>
            <p className="faint" style={{ fontSize: "var(--fs-12)", marginTop: 4 }}>
              {t("snapshot.excludedHint")}
            </p>
          </div>
        )}

        <label className="checkbox">
          <input
            type="checkbox"
            checked={setAsResume}
            onChange={(e) => setSetAsResume(e.target.checked)}
          />
          {t("snapshot.setResume")}
        </label>
      </div>
    </Dialog>
  );
}
