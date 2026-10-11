import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Camera, ExternalLink, FolderOpen, GitBranch, Play } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useCollection } from "@/lib/db/database";
import { formatRelative } from "@/lib/time";
import { useUi } from "@/state/ui";
import type { MessageKey } from "@/lib/i18n/en";
import { StartSessionDialog } from "@/features/sessions/StartSessionDialog";
import { SnapshotCaptureDialog } from "@/features/snapshots/SnapshotCaptureDialog";
import { openLocalPath } from "@/features/files/linkedPaths";
import { ContextEmpty } from "./ContextEmpty";
import { useActiveProject } from "./useActiveProject";

const OPEN_TASK_PREVIEW = 3;

/** No project to show: say so and point to where one is made. */
export function NoProject() {
  const { t } = useT();
  const navigate = useNavigate();
  return (
    <ContextEmpty
      icon={FolderOpen}
      title={t("ctx.project.emptyTitle")}
      hint={t("ctx.project.emptyHint")}
      action={
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => navigate("/workspaces")}
        >
          <FolderOpen size={13} aria-hidden /> {t("ctx.project.open")}
        </button>
      }
    />
  );
}

/**
 * Project: which project is active and where it stands — folder,
 * repository, live session, the latest handoff and open tasks — with Start
 * session and Capture snapshot for it.
 */
export function ProjectSegment() {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const setActiveWorkspace = useUi((s) => s.setActiveWorkspace);
  const { projects, project } = useActiveProject();
  const sessions = useCollection("sessions");
  const snapshots = useCollection("snapshots");
  const tasks = useCollection("tasks");
  const [sessionOpen, setSessionOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);

  if (!project) return <NoProject />;

  const live = sessions.find((s) => s.workspaceId === project.id && s.status === "active");
  const handoff =
    snapshots.find((s) => s.id === project.resumeSnapshotId && s.handoff.trim()) ??
    snapshots
      .filter((s) => s.workspaceId === project.id && s.handoff.trim())
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  const openTasks = tasks.filter(
    (task) =>
      task.workspaceId === project.id && task.status !== "done" && task.status !== "archived",
  );
  const git = project.git?.connected ? project.git : undefined;

  const openFolder = () => {
    if (project.localPath) void openLocalPath(project.localPath);
  };

  return (
    <div className="ctx-project">
      <div className="ctx-field">
        <label className="ctx-lbl" htmlFor="ctx-project-picker">
          {t("ctx.project.active")}
        </label>
        <select
          id="ctx-project-picker"
          className="select"
          value={project.id}
          onChange={(e) => setActiveWorkspace(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <section className="ctx-card">
        <span className="ctx-mono" style={{ color: project.color }} aria-hidden>
          {project.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="ctx-card__body">
          <div className="ctx-card__title">
            <strong>{project.name}</strong>
            <span className={`ctx-chip health-${project.health}`}>
              {t(`health.${project.health}` as MessageKey)}
            </span>
          </div>
          {project.purpose && <p className="ctx-card__purpose">{project.purpose}</p>}
          <p className="ctx-card__meta">
            {t(`ws.type.${project.type}` as MessageKey)} ·{" "}
            {formatRelative(project.lastActivityAt, locale)}
          </p>
        </div>
      </section>

      <dl className="ctx-kv">
        <dt>{t("ctx.project.path")}</dt>
        <dd className="ctx-kv__row">
          {project.localPath ? (
            <>
              <span className="mono ctx-trunc" title={project.localPath}>
                {project.localPath}
              </span>
              <button
                type="button"
                className="ctx-icon-btn"
                onClick={() => void openFolder()}
                aria-label={t("ctx.project.openFolder")}
                title={t("ctx.project.openFolder")}
              >
                <ExternalLink size={13} aria-hidden />
              </button>
            </>
          ) : (
            <span className="ctx-faint">{t("ctx.project.noPath")}</span>
          )}
        </dd>
        <dt>{t("ctx.project.repo")}</dt>
        <dd>
          {git ? (
            <span className="ctx-inline">
              <GitBranch size={12} aria-hidden />
              <span className="mono">{git.branch ?? "—"}</span>
              <span>· {t("ws.dirtyFiles", { count: git.dirtyFiles })}</span>
              <span>· {t("ws.aheadBehind", { ahead: git.ahead, behind: git.behind })}</span>
            </span>
          ) : (
            <span className="ctx-faint">{t("ctx.project.noRepo")}</span>
          )}
        </dd>
        <dt>{t("ctx.project.session")}</dt>
        <dd>
          {live ? (
            <span className="ctx-inline">
              <span className="ctx-dot" aria-hidden />
              {live.title} <span className="ctx-faint">· {t("ctx.project.live")}</span>
            </span>
          ) : (
            <span className="ctx-faint">{t("ctx.project.noSession")}</span>
          )}
        </dd>
      </dl>

      {handoff && (
        <section className="ctx-sec">
          <h3 className="ctx-lbl">{t("ctx.project.handoff")}</h3>
          <p className="ctx-handoff">{handoff.handoff}</p>
          <p className="ctx-faint">
            {t("ctx.project.handoffFrom", { date: new Date(handoff.createdAt).toLocaleString() })}
          </p>
        </section>
      )}

      <section className="ctx-sec">
        <h3 className="ctx-lbl">
          {t("ctx.project.tasks")}
          {openTasks.length > 0 && <span className="ctx-n">{openTasks.length}</span>}
        </h3>
        {openTasks.length === 0 ? (
          <p className="ctx-faint">{t("ctx.project.noTasks")}</p>
        ) : (
          <ul className="ctx-tasks">
            {openTasks.slice(0, OPEN_TASK_PREVIEW).map((task) => (
              <li key={task.id}>{task.title}</li>
            ))}
          </ul>
        )}
        {openTasks.length > OPEN_TASK_PREVIEW && (
          <button
            type="button"
            className="ctx-link"
            onClick={() => navigate(`/workspaces/${project.id}`)}
          >
            {t("ctx.project.allTasks", { count: openTasks.length })}{" "}
            <ArrowRight size={13} aria-hidden />
          </button>
        )}
      </section>

      <footer className="ctx-foot">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setSessionOpen(true)}>
          <Play size={13} aria-hidden /> {t("session.start")}
        </button>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => setCaptureOpen(true)}>
          <Camera size={13} aria-hidden /> {t("snapshot.capture")}
        </button>
      </footer>

      <StartSessionDialog
        open={sessionOpen}
        onClose={() => setSessionOpen(false)}
        defaultWorkspaceId={project.id}
      />
      <SnapshotCaptureDialog
        workspaceId={project.id}
        sessionId={live?.id}
        open={captureOpen}
        onClose={() => setCaptureOpen(false)}
      />
    </div>
  );
}
