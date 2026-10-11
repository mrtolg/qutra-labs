import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Play,
  Camera,
  Timer,
  GitBranch,
  GitCommitHorizontal,
  ExternalLink,
  Folder,
  PanelRight,
  Sparkles,
  RotateCcw,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { getDb, useCollection } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { EmptyState } from "@/components/ui/EmptyState";
import { RestoreDialog, useResumeSnapshot } from "@/features/restore/RestoreDialog";
import { SnapshotCaptureDialog } from "@/features/snapshots/SnapshotCaptureDialog";
import { StartSessionDialog } from "@/features/sessions/StartSessionDialog";
import { openContextPanel } from "@/app/context/panelState";
import { useGlideThumb } from "@/app/useGlideThumb";
import { formatDate, formatDateTime, formatRelative, now } from "@/lib/time";
import { getBridge } from "@/lib/bridge";
import { executeAutomation } from "@/services/appService";
import { dryRunPlan } from "@/domain/automations";
import type { Snapshot } from "@/domain/types";
import type { MessageKey } from "@/lib/i18n/en";

const TABS = [
  "overview",
  "sessions",
  "tasks",
  "resources",
  "git",
  "snapshots",
  "automations",
  "activity",
  "settings",
] as const;
type Tab = (typeof TABS)[number];

export default function WorkspaceDetailPage() {
  const { id, tab } = useParams<{ id: string; tab?: Tab }>();
  const navigate = useNavigate();
  const { t, locale } = useT();
  const { setActiveWorkspace, toast } = useUi();
  const workspaces = useCollection("workspaces");
  const sessions = useCollection("sessions");
  const tasks = useCollection("tasks");
  const resources = useCollection("resources");
  const snapshots = useCollection("snapshots");
  const restoreRuns = useCollection("restoreRuns");
  const automations = useCollection("automations");
  const automationRuns = useCollection("automationRuns");
  const events = useCollection("events");

  const ws = workspaces.find((w) => w.id === id);
  const activeTab: Tab = TABS.includes(tab as Tab) ? (tab as Tab) : "overview";

  const [restoreSnap, setRestoreSnap] = useState<Snapshot | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [runningAutomationId, setRunningAutomationId] = useState<string | null>(
    null,
  );
  const resumeSnapshot = useResumeSnapshot(ws?.id);
  const tabsGlide = useGlideThumb<HTMLDivElement>(
    `${activeTab}|${locale}|${ws?.id ?? ""}`,
    '[aria-selected="true"]',
  );

  useEffect(() => {
    if (ws) setActiveWorkspace(ws.id);
  }, [ws, setActiveWorkspace]);

  /* Deep-linked actions from the Command Palette.
     `?action=start-session` / `?action=capture` open the real dialog on arrival.
     The parameter is consumed immediately — left in place it would reopen the
     dialog on every back-navigation or refresh, and would also make the URL a
     distinct working tab from the plain workspace route. */
  const [actionParams, setActionParams] = useSearchParams();
  const requestedAction = actionParams.get("action");
  useEffect(() => {
    if (!ws || !requestedAction) return;
    if (requestedAction === "start-session") setSessionOpen(true);
    else if (requestedAction === "capture") setCaptureOpen(true);

    const next = new URLSearchParams(actionParams);
    next.delete("action");
    setActionParams(next, { replace: true });
  }, [ws, requestedAction, actionParams, setActionParams]);

  const wsSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.workspaceId === id)
        .sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt)),
    [sessions, id],
  );
  const wsTasks = tasks.filter((task) => task.workspaceId === id);
  const openTasks = wsTasks.filter(
    (task) => task.status !== "done" && task.status !== "archived",
  );
  const wsResources = resources
    .filter((r) => r.workspaceId === id)
    .sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt));
  const wsSnapshots = snapshots
    .filter((s) => s.workspaceId === id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const wsAutomations = automations.filter((a) =>
    a.conditions.some((c) => c.field === "workspace" && c.value === id),
  );
  const wsEvents = events
    .filter((e) => e.workspaceId === id && e.type !== "app_activity")
    .sort((a, b) => b.at - a.at);
  const lastCompleted = wsSessions.find((s) => s.status === "completed");
  const currentSession = wsSessions.find(
    (s) => s.status === "active" || s.status === "paused",
  );
  const blockedTasks = openTasks.filter((task) => task.blockedByIds.length > 0);

  if (!ws) {
    return (
      <div className="page">
        <div className="page-body">
          <EmptyState
            icon={Folder}
            title={t("notFound.title")}
            action={
              <Link to="/workspaces" className="btn btn--secondary">
                {t("ws.title")}
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const db = getDb();
  const setTab = (next: Tab) =>
    navigate(`/workspaces/${ws.id}${next === "overview" ? "" : `/${next}`}`);

  return (
    <div className="page">
      <div className="page-header">
        <div className="breadcrumb">
          <Link to="/workspaces">{t("ws.title")}</Link>
          <span aria-hidden>/</span>
          <span>{ws.name}</span>
        </div>
        <div className="ws-header">
          <span className="ws-icon" style={{ background: ws.color }} aria-hidden>
            <Folder size={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="page-title-row" style={{ minHeight: 0 }}>
              <h1>{ws.name}</h1>
              <span
                className={`badge ${
                  ws.health === "ready"
                    ? "badge--success"
                    : ws.health === "needs_handoff"
                      ? "badge--warning"
                      : "badge--danger"
                }`}
              >
                {t(`health.${ws.health}` as MessageKey)}
              </span>
              {ws.demo && <span className="badge badge--outline">{t("common.demo")}</span>}
            </div>
            <div className="muted" style={{ fontSize: "var(--fs-12)", display: "flex", gap: 12, flexWrap: "wrap" }}>
              {ws.purpose && <span>{ws.purpose}</span>}
              {ws.localPath && <span className="mono">{ws.localPath}</span>}
              {ws.git?.connected && (
                <span className="flex" style={{ gap: 4, display: "inline-flex" }}>
                  <GitBranch size={12} aria-hidden />
                  <span className="mono">{ws.git.branch}</span>
                  {ws.git.dirtyFiles > 0 && (
                    <span>· {t("ws.dirtyFiles", { count: ws.git.dirtyFiles })}</span>
                  )}
                </span>
              )}
            </div>
          </div>
          <div className="toolbar" style={{ flexWrap: "nowrap" }}>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                setActiveWorkspace(ws.id);
                openContextPanel("project");
              }}
            >
              <PanelRight size={13} aria-hidden /> {t("ctx.show")}
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setCaptureOpen(true)}
            >
              <Camera size={13} aria-hidden /> {t("snapshot.capture")}
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setSessionOpen(true)}
            >
              <Timer size={13} aria-hidden /> {t("session.new")}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!resumeSnapshot}
              onClick={() => resumeSnapshot && setRestoreSnap(resumeSnapshot)}
            >
              <Play size={13} aria-hidden /> {t("today.resume")}
            </button>
          </div>
        </div>
        <div
          ref={tabsGlide.ref}
          className={tabsGlide.thumb ? "tabs has-thumb" : "tabs"}
          role="tablist"
          aria-label={ws.name}
          style={{ marginTop: "var(--sp-3)" }}
        >
          {tabsGlide.thumb && (
            <span
              className="tabs__thumb"
              aria-hidden
              style={{
                transform: `translateX(${tabsGlide.thumb.x}px)`,
                width: tabsGlide.thumb.width,
              }}
            />
          )}
          {TABS.map((tb) => (
            <button
              key={tb}
              role="tab"
              aria-selected={activeTab === tb}
              onClick={() => setTab(tb)}
            >
              {t(`ws.tab.${tb}` as MessageKey)}
            </button>
          ))}
        </div>
      </div>

      {/* Focusable so a keyboard user can scroll a panel with no controls. */}
      <div className="page-body" role="tabpanel" tabIndex={0}>
        {activeTab === "overview" && (
          <div className="two-col">
            <div className="stack" style={{ gap: "var(--sp-4)" }}>
              <section className="panel">
                <div className="panel-header">
                  <span className="panel-title">{t("ws.latestHandoff")}</span>
                  {lastCompleted?.endedAt && (
                    <span className="faint" style={{ fontSize: "var(--fs-12)" }}>
                      {formatRelative(lastCompleted.endedAt, locale)}
                    </span>
                  )}
                </div>
                <div className="panel-body">
                  {resumeSnapshot?.handoff ? (
                    <p style={{ fontSize: "var(--fs-13)" }}>“{resumeSnapshot.handoff}”</p>
                  ) : (
                    <p className="muted" style={{ fontSize: "var(--fs-13)" }}>
                      {t("ws.noHandoff")}
                    </p>
                  )}
                  {lastCompleted?.review?.nextAction && (
                    <p style={{ marginTop: "var(--sp-2)", fontSize: "var(--fs-13)" }}>
                      <strong>{t("ws.nextAction")}:</strong>{" "}
                      {lastCompleted.review.nextAction}
                    </p>
                  )}
                </div>
              </section>

              {currentSession && (
                <section className="session-strip">
                  <Timer size={15} aria-hidden style={{ color: "var(--primary)" }} />
                  <div style={{ flex: 1 }}>
                    <strong>{currentSession.title}</strong>
                  </div>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => navigate("/sessions/focus")}
                  >
                    {t("session.focusMode")}
                  </button>
                </section>
              )}

              {blockedTasks.length > 0 && (
                <section className="panel">
                  <div className="panel-header">
                    <span className="panel-title">{t("ws.blockers")}</span>
                  </div>
                  <div className="row-list">
                    {blockedTasks.map((task) => (
                      <div key={task.id} className="row" style={{ cursor: "default" }}>
                        <span className="dot dot--warning" aria-hidden />
                        <span className="truncate" style={{ flex: 1 }}>{task.title}</span>
                        <span className="faint" style={{ fontSize: "var(--fs-12)" }}>
                          {t("task.blockedBy")}:{" "}
                          {task.blockedByIds
                            .map((bid) => tasks.find((x) => x.id === bid)?.title)
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="panel">
                <div className="panel-header">
                  <span className="panel-title">
                    {t("ws.linkedTasks")} ({openTasks.length})
                  </span>
                  {/* `/tasks` is a retired route that redirects to the project
                      list, dropping both the workspace and the filter. This page
                      already has a tasks tab — go there and keep the context the
                      user is standing in. */}
                  <Link to={`/workspaces/${ws.id}/tasks`} className="btn btn--ghost btn--sm">
                    {t("action.viewAll")}
                  </Link>
                </div>
                <div className="row-list">
                  {openTasks.slice(0, 6).map((task) => (
                    <div key={task.id} className="row" style={{ cursor: "default" }}>
                      <span
                        className={`dot ${
                          task.status === "in_progress" ? "dot--info" : "dot--muted"
                        }`}
                        aria-hidden
                      />
                      <span className="truncate" style={{ flex: 1 }}>{task.title}</span>
                      <span className="badge badge--neutral">
                        {t(`task.${task.status}` as MessageKey)}
                      </span>
                    </div>
                  ))}
                  {openTasks.length === 0 && (
                    <div className="panel-body muted" style={{ fontSize: "var(--fs-13)" }}>—</div>
                  )}
                </div>
              </section>
            </div>

            <div className="stack" style={{ gap: "var(--sp-4)" }}>
              {ws.git?.connected && (
                <section className="panel">
                  <div className="panel-header">
                    <span className="panel-title">{t("ws.recentCommits")}</span>
                  </div>
                  <div className="row-list">
                    {ws.git.lastCommits.map((c) => (
                      <div key={c.hash} className="row" style={{ cursor: "default" }}>
                        <GitCommitHorizontal size={14} aria-hidden style={{ color: "var(--muted)", flex: "none" }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span className="truncate" style={{ display: "block" }}>{c.message}</span>
                          <span className="faint mono" style={{ fontSize: "var(--fs-12)" }}>
                            {c.hash} · <span style={{ color: "var(--git-add)" }}>+{c.additions}</span>{" "}
                            <span style={{ color: "var(--git-del)" }}>−{c.deletions}</span>
                          </span>
                        </span>
                        <span className="faint" style={{ fontSize: "var(--fs-12)", flex: "none" }}>
                          {formatRelative(c.at, locale)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="panel">
                <div className="panel-header">
                  <span className="panel-title">{t("ws.recentResources")}</span>
                </div>
                <div className="row-list">
                  {wsResources.slice(0, 5).map((r) => (
                    <div key={r.id} className="row" style={{ cursor: "default" }}>
                      <span className="truncate" style={{ flex: 1 }}>{r.title}</span>
                      {r.kind === "url" && (
                        <button
                          type="button"
                          className="btn btn--icon btn--sm"
                          aria-label={`${t("action.open")}: ${r.title}`}
                          onClick={() => void getBridge().openUrl(r.target)}
                        >
                          <ExternalLink size={13} aria-hidden />
                        </button>
                      )}
                    </div>
                  ))}
                  {wsResources.length === 0 && (
                    <div className="panel-body muted" style={{ fontSize: "var(--fs-13)" }}>—</div>
                  )}
                </div>
              </section>

              {ws.defaultCommands.length > 0 && (
                <section className="panel">
                  <div className="panel-header">
                    <span className="panel-title">{t("ws.quickLaunch")}</span>
                  </div>
                  <div className="panel-body stack">
                    {ws.defaultCommands.map((cmd) => (
                      <div key={cmd} className="flex">
                        <code className="mono" style={{ flex: 1 }}>{cmd}</code>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => {
                            void getBridge().writeClipboard(cmd);
                            toast({ kind: "info", messageKey: "toast.copied" });
                          }}
                        >
                          {t("action.copy")}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        )}

        {activeTab === "sessions" && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("common.title")}</th>
                  <th scope="col">{t("common.status")}</th>
                  <th scope="col">{t("session.review.nextAction")}</th>
                  <th scope="col">{t("common.lastActivity")}</th>
                </tr>
              </thead>
              <tbody>
                {wsSessions.map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 500 }}>{s.title}</td>
                    <td>
                      <span className={`badge ${s.status === "completed" ? "badge--success" : "badge--primary"}`}>
                        {t(`status.${s.status}` as MessageKey)}
                      </span>
                    </td>
                    <td className="muted truncate" style={{ maxWidth: 280 }}>
                      {s.review?.nextAction || "—"}
                    </td>
                    <td className="muted">
                      {formatRelative(s.endedAt ?? s.startedAt ?? s.createdAt, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {wsSessions.length === 0 && (
              <EmptyState icon={Timer} title={t("session.empty")} hint={t("session.emptyHint")} />
            )}
          </div>
        )}

        {activeTab === "tasks" && (
          <div className="row-list panel">
            {wsTasks.length === 0 ? (
              <EmptyState icon={Timer} title={t("today.noTasksToday")} />
            ) : (
              wsTasks
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map((task) => (
                  <div key={task.id} className="row" style={{ cursor: "default" }}>
                    <input
                      id={`task-done-${task.id}`}
                      type="checkbox"
                      checked={task.status === "done"}
                      aria-label={`${t("task.markDone")}: ${task.title}`}
                      onChange={() =>
                        task.status === "done"
                          ? db.collection("tasks").patch(task.id, { status: "todo", completedAt: undefined, updatedAt: now() })
                          : db.collection("tasks").patch(task.id, { status: "done", completedAt: now(), updatedAt: now() })
                      }
                    />
                    <label
                      htmlFor={`task-done-${task.id}`}
                      className="truncate"
                      style={{
                        flex: 1,
                        textDecoration: task.status === "done" ? "line-through" : undefined,
                        color: task.status === "done" ? "var(--muted)" : undefined,
                      }}
                    >
                      {task.title}
                    </label>
                    <span className="badge badge--neutral">
                      {t(`task.${task.status}` as MessageKey)}
                    </span>
                  </div>
                ))
            )}
          </div>
        )}

        {activeTab === "resources" && (
          <div className="row-list panel">
            {wsResources.length === 0 ? (
              <EmptyState icon={ExternalLink} title="—" />
            ) : (
              wsResources.map((r) => (
                <div key={r.id} className="row" style={{ cursor: "default" }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="truncate" style={{ display: "block", fontWeight: 500 }}>{r.title}</span>
                    <span className="muted mono truncate" style={{ display: "block", fontSize: "var(--fs-12)" }}>
                      {r.target}
                    </span>
                  </span>
                  {r.tags.map((tag) => (
                    <span key={tag} className="tag-chip">
                      {tag}
                    </span>
                  ))}
                  {r.kind === "url" && (
                    <button
                      type="button"
                      className="btn btn--icon btn--sm"
                      aria-label={`${t("action.open")}: ${r.title}`}
                      onClick={() => void getBridge().openUrl(r.target)}
                    >
                      <ExternalLink size={13} aria-hidden />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === "git" && (
          <div className="stack" style={{ gap: "var(--sp-4)", maxWidth: 720 }}>
            {ws.git?.connected ? (
              <>
                <div className="stat-inline panel panel-body" style={{ padding: "var(--sp-3)" }}>
                  <div>
                    <span className="stat-value mono">{ws.git.branch}</span>
                    <span className="stat-label">{t("common.branch")}</span>
                  </div>
                  <div>
                    <span className="stat-value">{ws.git.dirtyFiles}</span>
                    <span className="stat-label">{t("today.changedFiles", { count: "" }).trim()}</span>
                  </div>
                  <div>
                    <span className="stat-value">
                      {t("ws.aheadBehind", { ahead: ws.git.ahead, behind: ws.git.behind })}
                    </span>
                    <span className="stat-label">origin</span>
                  </div>
                </div>
                <section className="panel">
                  <div className="panel-header">
                    <span className="panel-title">{t("ws.recentCommits")}</span>
                  </div>
                  <div className="row-list">
                    {ws.git.lastCommits.map((c) => (
                      <div key={c.hash} className="row" style={{ cursor: "default" }}>
                        <GitCommitHorizontal size={14} aria-hidden style={{ color: "var(--muted)" }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span className="truncate" style={{ display: "block" }}>{c.message}</span>
                          <span className="faint mono" style={{ fontSize: "var(--fs-12)" }}>
                            {c.hash} · {formatDateTime(c.at, locale)}
                          </span>
                        </span>
                        <span className="mono" style={{ fontSize: "var(--fs-12)", flex: "none" }}>
                          <span style={{ color: "var(--git-add)" }}>+{c.additions}</span>{" "}
                          <span style={{ color: "var(--git-del)" }}>−{c.deletions}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
                <p className="faint" style={{ fontSize: "var(--fs-12)" }}>
                  {getBridge().capabilities().gitInspection.simulated && t("perm.simulated")}
                </p>
              </>
            ) : (
              <EmptyState
                icon={GitBranch}
                title={t("common.notConnected")}
                action={
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => {
                      db.collection("workspaces").patch(ws.id, {
                        git: {
                          connected: true,
                          branch: "main",
                          dirtyFiles: 0,
                          ahead: 0,
                          behind: 0,
                          lastCommits: [],
                        },
                        updatedAt: now(),
                      });
                      toast({ kind: "info", messageKey: "perm.simulated" });
                    }}
                  >
                    {t("ws.connectRepo")}
                  </button>
                }
              />
            )}
          </div>
        )}

        {activeTab === "snapshots" && (
          <div className="stack" style={{ gap: "var(--sp-3)" }}>
            {wsSnapshots.length === 0 ? (
              <EmptyState
                icon={Camera}
                title={t("snapshot.empty")}
                hint={t("snapshot.emptyHint")}
                action={
                  <button type="button" className="btn btn--primary" onClick={() => setCaptureOpen(true)}>
                    {t("snapshot.capture")}
                  </button>
                }
              />
            ) : (
              <div className="row-list panel">
                {wsSnapshots.map((snap) => (
                  <div key={snap.id} className="row" style={{ cursor: "default" }}>
                    <Camera size={14} aria-hidden style={{ color: "var(--muted)", flex: "none" }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="truncate" style={{ display: "block", fontWeight: 500 }}>
                        {snap.name}
                        {ws.resumeSnapshotId === snap.id && (
                          <span className="badge badge--primary" style={{ marginLeft: 8 }}>
                            {t("today.resume")}
                          </span>
                        )}
                      </span>
                      <span className="muted" style={{ fontSize: "var(--fs-12)" }}>
                        {t("snapshot.items", { count: snap.items.length })} ·{" "}
                        {formatDateTime(snap.createdAt, locale)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setRestoreSnap(snap)}
                    >
                      <RotateCcw size={13} aria-hidden /> {t("today.resume")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Restore history */}
            {restoreRuns.filter((r) => r.workspaceId === ws.id).length > 0 && (
              <section className="panel">
                <div className="panel-header">
                  <span className="panel-title">{t("restore.history")}</span>
                </div>
                <div className="row-list">
                  {restoreRuns
                    .filter((r) => r.workspaceId === ws.id)
                    .sort((a, b) => b.startedAt - a.startedAt)
                    .slice(0, 6)
                    .map((run) => {
                      const failed = run.items.filter(
                        (i) => i.state === "failed" || i.state === "permission_required",
                      ).length;
                      return (
                        <div key={run.id} className="row" style={{ cursor: "default" }}>
                          <span
                            className={`badge ${
                              run.status === "completed"
                                ? "badge--success"
                                : run.status === "partial"
                                  ? "badge--warning"
                                  : "badge--neutral"
                            }`}
                          >
                            {t(`status.${run.status}` as MessageKey)}
                          </span>
                          <span style={{ flex: 1, fontSize: "var(--fs-13)" }}>
                            {snapshots.find((s) => s.id === run.snapshotId)?.name ?? run.snapshotId}
                            {failed > 0 && (
                              <span className="muted"> · {failed} {t("restore.state.failed").toLowerCase()}</span>
                            )}
                          </span>
                          <span className="faint" style={{ fontSize: "var(--fs-12)" }}>
                            {formatRelative(run.startedAt, locale)}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </section>
            )}
          </div>
        )}

        {activeTab === "automations" && (
          <div className="row-list panel">
            {wsAutomations.length === 0 ? (
              <EmptyState icon={Sparkles} title={t("auto.empty")} hint={t("auto.emptyHint")} />
            ) : (
              wsAutomations.map((a) => (
                <div key={a.id} className="row" style={{ cursor: "default" }}>
                  <span className={`dot ${a.enabled ? "dot--success" : "dot--muted"}`} aria-hidden />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="truncate" style={{ display: "block", fontWeight: 500 }}>{a.name}</span>
                    <span className="muted" style={{ fontSize: "var(--fs-12)" }}>
                      {t(`auto.trigger.${a.trigger}` as MessageKey)} → {dryRunPlan(a).join(", ")}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    disabled={runningAutomationId !== null}
                    aria-busy={runningAutomationId === a.id}
                    onClick={async () => {
                      setRunningAutomationId(a.id);
                      try {
                        const result = await executeAutomation(a, undefined, {
                          confirmed: true,
                        });
                        toast({
                          kind: result.ok
                            ? "success"
                            : result.status === "failed"
                              ? "danger"
                              : "info",
                          message: `${t("auto.ran")}: ${result.detail}`,
                        });
                      } finally {
                        setRunningAutomationId(null);
                      }
                    }}
                  >
                    {t("auto.trigger.manual")}
                  </button>
                </div>
              ))
            )}
            {automationRuns.length > 0 && wsAutomations.length > 0 && (
              <div className="panel-body muted" style={{ fontSize: "var(--fs-12)" }}>
                {t("auto.lastRun")}:{" "}
                {(() => {
                  const runs = automationRuns
                    .filter((r) => wsAutomations.some((a) => a.id === r.automationId))
                    .sort((a, b) => b.at - a.at);
                  return runs[0] ? `${formatDateTime(runs[0].at, locale)} · ${runs[0].detail}` : "—";
                })()}
              </div>
            )}
          </div>
        )}

        {activeTab === "activity" && (
          <div className="stack">
            {wsEvents.length === 0 ? (
              <EmptyState icon={Timer} title={t("activity.empty")} />
            ) : (
              wsEvents.slice(0, 40).map((e) => (
                <div key={e.id} className={`tl-event tl-event--${e.type}`}>
                  <span className="tl-time">{formatDate(e.at, locale)}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="truncate" style={{ display: "block" }}>{e.label}</span>
                    {e.detail && (
                      <span className="muted" style={{ fontSize: "var(--fs-12)" }}>{e.detail}</span>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === "settings" && (
          <WorkspaceSettings wsId={ws.id} />
        )}
      </div>

      {restoreSnap && (
        <RestoreDialog
          snapshot={restoreSnap}
          open={restoreSnap !== null}
          onClose={() => setRestoreSnap(null)}
        />
      )}
      <SnapshotCaptureDialog
        workspaceId={ws.id}
        sessionId={currentSession?.id}
        open={captureOpen}
        onClose={() => setCaptureOpen(false)}
      />
      <StartSessionDialog
        open={sessionOpen}
        onClose={() => setSessionOpen(false)}
        defaultWorkspaceId={ws.id}
      />
    </div>
  );
}

function WorkspaceSettings({ wsId }: { wsId: string }) {
  const { t } = useT();
  const { toast } = useUi();
  const workspaces = useCollection("workspaces");
  const ws = workspaces.find((w) => w.id === wsId);
  const [purpose, setPurpose] = useState(ws?.purpose ?? "");
  const [commands, setCommands] = useState(ws?.defaultCommands.join("\n") ?? "");
  const [ignored, setIgnored] = useState(ws?.ignoredPaths.join("\n") ?? "");
  const [envLabels, setEnvLabels] = useState(ws?.environmentLabels.join(", ") ?? "");
  const [restoreBehavior, setRestoreBehavior] = useState(ws?.restoreBehavior ?? "ask");

  if (!ws) return null;
  const db = getDb();

  const save = () => {
    db.collection("workspaces").patch(ws.id, {
      purpose: purpose.trim(),
      defaultCommands: commands.split("\n").map((c) => c.trim()).filter(Boolean),
      ignoredPaths: ignored.split("\n").map((c) => c.trim()).filter(Boolean),
      environmentLabels: envLabels.split(",").map((c) => c.trim()).filter(Boolean),
      restoreBehavior,
      updatedAt: now(),
    });
    toast({ kind: "success", messageKey: "toast.saved" });
  };

  return (
    <div className="stack" style={{ gap: "var(--sp-3)", maxWidth: 560 }}>
      <div className="field">
        <label htmlFor="wss-purpose">{t("ws.purpose")}</label>
        <input id="wss-purpose" className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="wss-commands">{t("ws.defaultCommands")}</label>
        <textarea id="wss-commands" className="textarea mono" rows={3} value={commands} onChange={(e) => setCommands(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="wss-ignored">{t("ws.ignoredPaths")}</label>
        <textarea id="wss-ignored" className="textarea mono" rows={3} value={ignored} onChange={(e) => setIgnored(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="wss-env">{t("ws.envLabels")}</label>
        <input id="wss-env" className="input" value={envLabels} onChange={(e) => setEnvLabels(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="wss-restore">{t("ws.restoreBehavior")}</label>
        <select
          id="wss-restore"
          className="select"
          value={restoreBehavior}
          onChange={(e) => setRestoreBehavior(e.target.value as typeof restoreBehavior)}
        >
          <option value="ask">{t("ws.restore.ask")}</option>
          <option value="restore_all">{t("ws.restore.restore_all")}</option>
          <option value="restore_selected">{t("ws.restore.restore_selected")}</option>
        </select>
      </div>
      <div>
        <button type="button" className="btn btn--primary" onClick={save}>
          {t("action.save")}
        </button>
      </div>
    </div>
  );
}
