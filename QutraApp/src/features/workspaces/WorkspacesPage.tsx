import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FolderKanban,
  Plus,
  GitBranch,
  Star,
  MoreHorizontal,
  List,
  LayoutGrid,
  Search,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { getDb, useCollection, usePreferences } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { Menu, type MenuItemDef } from "@/components/ui/Menu";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { createId } from "@/lib/id";
import { now, formatRelative } from "@/lib/time";
import { recordEvent } from "@/services/appService";
import type { Workspace } from "@/domain/types";
import type { MessageKey } from "@/lib/i18n/en";

const COLORS = [
  { value: "oklch(0.45 0.15 330)", nameKey: "color.magenta" },
  { value: "oklch(0.55 0.11 190)", nameKey: "color.teal" },
  { value: "oklch(0.55 0.12 85)", nameKey: "color.amber" },
  { value: "oklch(0.5 0.12 250)", nameKey: "color.blue" },
  { value: "oklch(0.55 0.13 150)", nameKey: "color.green" },
  { value: "oklch(0.5 0.02 330)", nameKey: "color.gray" },
] as const;

export default function WorkspacesPage() {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const prefs = usePreferences();
  const { toast } = useUi();
  const workspaces = useCollection("workspaces");
  const sessions = useCollection("sessions");
  const tasks = useCollection("tasks");

  const db = getDb();
  const viewKey = "ws_view";
  const view = (prefs.viewSettings[viewKey] as "list" | "board") ?? "list";
  const setView = (v: "list" | "board") =>
    db.prefs.set({ viewSettings: { ...prefs.viewSettings, [viewKey]: v } });

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workspaces
      .filter((w) => {
        if (statusFilter === "attention")
          return w.health !== "ready" && w.status !== "archived";
        if (statusFilter === "favorite") return w.favorite && w.status !== "archived";
        if (statusFilter !== "all" && w.status !== statusFilter) return false;
        return true;
      })
      .filter(
        (w) =>
          !q ||
          w.name.toLowerCase().includes(q) ||
          w.purpose.toLowerCase().includes(q) ||
          w.tags.some((tag) => tag.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }, [workspaces, query, statusFilter]);

  const openTaskCount = (wsId: string) =>
    tasks.filter(
      (task) =>
        task.workspaceId === wsId &&
        task.status !== "done" &&
        task.status !== "archived",
    ).length;
  const lastSession = (wsId: string) =>
    sessions
      .filter((s) => s.workspaceId === wsId)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];

  const wsActions = (w: Workspace): (MenuItemDef | "separator")[] => [
    {
      key: "favorite",
      label: w.favorite ? t("action.unfavorite") : t("action.favorite"),
      onSelect: () =>
        db.collection("workspaces").patch(w.id, { favorite: !w.favorite }),
    },
    {
      key: "duplicate",
      label: t("action.duplicate"),
      onSelect: () => {
        const copy: Workspace = {
          ...w,
          id: createId("ws"),
          name: `${w.name} (copy)`,
          favorite: false,
          resumeSnapshotId: undefined,
          demo: false,
          createdAt: now(),
          updatedAt: now(),
          lastActivityAt: now(),
        };
        db.collection("workspaces").put(copy);
        toast({ kind: "success", messageKey: "ws.duplicated" });
      },
    },
    {
      key: "archive",
      label: w.status === "archived" ? t("action.unarchive") : t("action.archive"),
      onSelect: () => {
        db.collection("workspaces").patch(w.id, {
          status: w.status === "archived" ? "active" : "archived",
          updatedAt: now(),
        });
        if (w.status !== "archived")
          toast({ kind: "info", messageKey: "ws.archived" });
      },
    },
    {
      key: "export",
      label: t("action.export"),
      onSelect: () => {
        const payload = {
          workspace: w,
          sessions: sessions.filter((s) => s.workspaceId === w.id),
          tasks: tasks.filter((task) => task.workspaceId === w.id),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
          type: "application/json",
        });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `contextos-workspace-${w.name.replace(/\W+/g, "-").toLowerCase()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      },
    },
    "separator",
    {
      key: "delete",
      label: t("action.delete"),
      danger: true,
      onSelect: () => setDeleteTarget(w),
    },
  ];

  const statusOptions: { value: string; key: MessageKey }[] = [
    { value: "active", key: "status.active" },
    { value: "paused", key: "status.paused" },
    { value: "archived", key: "status.archived" },
    { value: "attention", key: "ws.filters.attention" },
    { value: "favorite", key: "ws.favorite" },
    { value: "all", key: "common.all" },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <h1>{t("ws.title")}</h1>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn--primary"
            data-guide="projects-new"
            onClick={() => setNewOpen(true)}
          >
            <Plus size={14} aria-hidden /> {t("ws.new")}
          </button>
        </div>
        <div className="toolbar toolbar--fields">
          <div className="field">
            <label htmlFor="ws-search">{t("ws.searchLabel")}</label>
            <div style={{ position: "relative" }}>
              <Search
                size={14}
                aria-hidden
                style={{
                  position: "absolute",
                  left: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--muted)",
                }}
              />
              <input
                id="ws-search"
                className="input"
                style={{ width: 240, paddingLeft: 28 }}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="ws-status">{t("common.status")}</label>
            <select
              id="ws-status"
              className="select"
              style={{ width: 170 }}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {statusOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.key)}
                </option>
              ))}
            </select>
          </div>
          <div className="spacer" />
          <Segmented
            ariaLabel={t("ws.list")}
            value={view}
            onChange={setView}
            options={[
              { value: "list", label: t("ws.list"), icon: <List size={13} aria-hidden /> },
              { value: "board", label: t("ws.board"), icon: <LayoutGrid size={13} aria-hidden /> },
            ]}
          />
        </div>
      </div>

      <div className="page-body">
        {workspaces.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title={t("ws.empty")}
            hint={t("ws.emptyHint")}
            action={
              <button type="button" className="btn btn--primary" onClick={() => setNewOpen(true)}>
                {t("ws.new")}
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title={t("common.noResults")}
            action={
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => {
                  setQuery("");
                  setStatusFilter("all");
                }}
              >
                {t("common.clearFilters")}
              </button>
            }
          />
        ) : view === "list" ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("common.name")}</th>
                  <th scope="col">{t("ws.repo")}</th>
                  <th scope="col">{t("ws.lastSession")}</th>
                  <th scope="col">{t("nav.tasks")}</th>
                  <th scope="col">{t("ws.health")}</th>
                  <th scope="col">
                    <span className="sr-only">{t("action.moreActions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((w) => {
                  const last = lastSession(w.id);
                  const openCount = openTaskCount(w.id);
                  return (
                    <tr
                      key={w.id}
                      onClick={() => navigate(`/workspaces/${w.id}`)}
                      style={{ cursor: "pointer" }}
                    >
                      <td>
                        <div className="flex" style={{ gap: 8 }}>
                          <span className="ws-dot" style={{ background: w.color }} aria-hidden />
                          <div style={{ minWidth: 0 }}>
                            <div className="flex" style={{ gap: 6 }}>
                              <span style={{ fontWeight: 600 }}>{w.name}</span>
                              {w.favorite && (
                                <Star
                                  size={12}
                                  aria-label={t("nav.favorites")}
                                  style={{ color: "var(--warning)", fill: "var(--warning)" }}
                                />
                              )}
                              {w.demo && (
                                <span className="badge badge--outline">{t("common.demo")}</span>
                              )}
                            </div>
                            <div className="muted truncate" style={{ fontSize: "var(--fs-12)", maxWidth: 280 }}>
                              {w.purpose}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {w.git?.connected ? (
                          <div className="flex" style={{ gap: 5, fontSize: "var(--fs-12)" }}>
                            <GitBranch size={12} aria-hidden style={{ color: "var(--muted)" }} />
                            <span className="mono">{w.git.branch}</span>
                            {w.git.dirtyFiles > 0 && (
                              <span className="badge badge--warning">
                                {t("ws.dirtyFiles", { count: w.git.dirtyFiles })}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="faint" style={{ fontSize: "var(--fs-12)" }}>
                            {t("common.notConnected")}
                          </span>
                        )}
                      </td>
                      <td className="muted" style={{ fontSize: "var(--fs-12)" }}>
                        {last ? (
                          <>
                            <div className="truncate" style={{ maxWidth: 180 }}>
                              {last.title}
                            </div>
                            <div className="faint">
                              {formatRelative(last.startedAt ?? last.createdAt, locale)}
                            </div>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={{ fontSize: "var(--fs-12)" }}>
                        <div>{t("ws.openTasks", { count: openCount })}</div>
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            w.health === "ready"
                              ? "badge--success"
                              : w.health === "needs_handoff"
                                ? "badge--warning"
                                : "badge--danger"
                          }`}
                        >
                          {t(`health.${w.health}` as MessageKey)}
                        </span>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="btn btn--icon btn--sm"
                          aria-label={`${t("action.moreActions")}: ${w.name}`}
                          aria-haspopup="menu"
                          onClick={(e) => {
                            menuAnchor.current = e.currentTarget;
                            setMenuFor(menuFor === w.id ? null : w.id);
                          }}
                        >
                          <MoreHorizontal size={15} aria-hidden />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="board">
            {(["active", "paused", "archived"] as const).map((status) => {
              const col = filtered.filter((w) => w.status === status);
              return (
                <div key={status} className="board-col">
                  <div className="board-col-header">
                    {t(`status.${status}` as MessageKey)}
                    <span className="faint">{col.length}</span>
                  </div>
                  <div className="board-col-body">
                    {col.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        className="board-card"
                        onClick={() => navigate(`/workspaces/${w.id}`)}
                      >
                        <div className="flex" style={{ gap: 6 }}>
                          <span className="ws-dot" style={{ background: w.color }} aria-hidden />
                          <span style={{ fontWeight: 600 }}>{w.name}</span>
                        </div>
                        <div className="muted" style={{ fontSize: "var(--fs-12)", marginTop: 4 }}>
                          {w.purpose}
                        </div>
                        <div className="flex" style={{ marginTop: 8, gap: 6, flexWrap: "wrap" }}>
                          <span
                            className={`badge ${
                              w.health === "ready" ? "badge--success" : "badge--warning"
                            }`}
                          >
                            {t(`health.${w.health}` as MessageKey)}
                          </span>
                          <span className="faint" style={{ fontSize: "var(--fs-12)" }}>
                            {formatRelative(w.lastActivityAt, locale)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menuFor && (
        <Menu
          anchorEl={menuAnchor.current}
          onClose={() => setMenuFor(null)}
          ariaLabel={t("action.moreActions")}
          items={wsActions(workspaces.find((w) => w.id === menuFor)!)}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("ws.deleteTitle")}
        body={t("ws.deleteBody", { name: deleteTarget?.name ?? "" })}
        confirmLabel={t("action.delete")}
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          const id = deleteTarget.id;
          // Explicit cascade: sessions, snapshots, restore runs and events go;
          // project-owned tasks/resources are kept but detached.
          db.collection("sessions").removeWhere((s) => s.workspaceId === id);
          db.collection("snapshots").removeWhere((s) => s.workspaceId === id);
          db.collection("restoreRuns").removeWhere((r) => r.workspaceId === id);
          db.collection("events").removeWhere((e) => e.workspaceId === id);
          const detach = (colName: "tasks" | "resources") => {
            const col = db.collection(colName);
            for (const row of col.getAll()) {
              if ((row as { workspaceId?: string }).workspaceId === id) {
                col.patch((row as { id: string }).id, {
                  workspaceId: undefined,
                } as never);
              }
            }
          };
          detach("tasks");
          detach("resources");
          db.collection("workspaces").remove(id);
          setDeleteTarget(null);
          toast({ kind: "info", messageKey: "toast.deleted" });
        }}
      />

      <NewWorkspaceDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(id) => navigate(`/workspaces/${id}`)}
      />
    </div>
  );
}

export function NewWorkspaceDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const { t } = useT();
  const { toast } = useUi();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [type, setType] = useState<Workspace["type"]>("software");
  const [path, setPath] = useState("");
  const [color, setColor] = useState<string>(COLORS[0].value);
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const create = async () => {
    if (!name.trim()) return;
    const db = getDb();
    const ws: Workspace = {
      id: createId("ws"),
      name: name.trim(),
      color,
      icon: "folder",
      purpose: purpose.trim(),
      type,
      status: "active",
      favorite: false,
      tags: [],
      localPath: path.trim() || undefined,
      git: path.trim()
        ? { connected: false, dirtyFiles: 0, ahead: 0, behind: 0, lastCommits: [] }
        : undefined,
      defaultCommands: [],
      environmentLabels: [],
      ignoredPaths: [],
      browserCollections: [],
      restoreBehavior: "ask",
      health: "needs_handoff",
      demo: false,
      createdAt: now(),
      updatedAt: now(),
      lastActivityAt: now(),
    };
    setCreating(true);
    try {
      await db.collection("workspaces").putDurable(ws);
      recordEvent("workspace_opened", ws.name, { workspaceId: ws.id });
      toast({ kind: "success", messageKey: "ws.created" });
      setName("");
      setPurpose("");
      setPath("");
      onClose();
      onCreated?.(ws.id);
    } catch {
      toast({ kind: "danger", messageKey: "error.dbBody" });
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("ws.new")}
      initialFocusRef={nameRef}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t("action.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!name.trim() || creating}
            onClick={() => void create()}
          >
            {t("action.create")}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: "var(--sp-3)" }}>
        <div className="field">
          <label htmlFor="ws-name">{t("common.name")}</label>
          <input
            id="ws-name"
            ref={nameRef}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !creating) void create();
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="ws-purpose">{t("ws.purpose")}</label>
          <input
            id="ws-purpose"
            className="input"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </div>
        <div className="two-col" style={{ gap: "var(--sp-3)" }}>
          <div className="field">
            <label htmlFor="ws-type">{t("capture.type")}</label>
            <select
              id="ws-type"
              className="select"
              value={type}
              onChange={(e) => setType(e.target.value as Workspace["type"])}
            >
              {(["software", "research", "design", "writing", "other"] as const).map(
                (ty) => (
                  <option key={ty} value={ty}>
                    {t(`ws.type.${ty}` as MessageKey)}
                  </option>
                ),
              )}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ws-path">
              {t("ws.localPath")}{" "}
              <span className="faint">({t("common.optional")})</span>
            </label>
            <input
              id="ws-path"
              className="input mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\Dev\project"
            />
          </div>
        </div>
        <div className="field">
          <label>{t("common.color")}</label>
          <div className="flex" role="group" aria-label={t("common.color")}>
            {COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-label={t(c.nameKey as MessageKey)}
                title={t(c.nameKey as MessageKey)}
                aria-pressed={color === c.value}
                onClick={() => setColor(c.value)}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: c.value,
                  border:
                    color === c.value
                      ? "2px solid var(--ink)"
                      : "2px solid transparent",
                  cursor: "pointer",
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
