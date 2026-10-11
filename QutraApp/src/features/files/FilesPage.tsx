import { useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  File,
  Folder,
  FolderOpen,
  FolderSearch,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { useCollection } from "@/lib/db/database";
import { getBridge } from "@/lib/bridge";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import { addLinkedPath, openLinkedPath, removeLinkedPath } from "./linkedPaths";
import { scrollBehavior } from "@/lib/motion";

export default function FilesPage() {
  const { t } = useT();
  const { toast } = useUi();
  const resources = useCollection("resources");
  const workspaces = useCollection("workspaces");
  const pathInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [workspaceId, setWorkspaceId] = useState("all");
  const [path, setPath] = useState("");
  const [kind, setKind] = useState<"file" | "folder">("file");
  const [attachTo, setAttachTo] = useState("");

  const canPick = getBridge().capabilities().pickPath.available;

  const activeProjects = useMemo(
    () => workspaces.filter((workspace) => workspace.status !== "archived"),
    [workspaces],
  );

  const files = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return resources
      .filter((resource) => resource.kind === "file" || resource.kind === "folder")
      .filter(
        (resource) =>
          workspaceId === "all" || resource.workspaceId === workspaceId,
      )
      .filter(
        (resource) =>
          !needle ||
          resource.title.toLocaleLowerCase().includes(needle) ||
          resource.target.toLocaleLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt),
      );
  }, [query, resources, workspaceId]);

  const addResource = (overridePath?: string, overrideKind?: "file" | "folder") => {
    if (addLinkedPath(overridePath ?? path, overrideKind ?? kind, attachTo)) setPath("");
  };

  const browse = async (directory: boolean) => {
    if (!canPick) {
      toast({ kind: "info", messageKey: "files.pickDesktopOnly" });
      pathInputRef.current?.focus();
      return;
    }
    const selected = await getBridge().pickPath({ directory });
    if (!selected) return;
    setKind(directory ? "folder" : "file");
    setPath(selected);
    addResource(selected, directory ? "folder" : "file");
  };

  const openResource = openLinkedPath;
  const removeResource = removeLinkedPath;

  const focusAddForm = () => {
    pathInputRef.current?.focus();
    pathInputRef.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <div>
            <h1>{t("files.title")}</h1>
            <p className="muted">{t("files.subtitle")}</p>
          </div>
        </div>
        <div className="toolbar toolbar--fields">
          <div className="field">
            <label htmlFor="files-search">{t("files.search")}</label>
            <div className="search-input">
              <Search size={14} aria-hidden />
              <input
                id="files-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="files-project-filter">{t("files.projectFilter")}</label>
            <select
              id="files-project-filter"
              className="select"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              <option value="all">{t("files.allProjects")}</option>
              {activeProjects.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="page-body stack" style={{ gap: "var(--sp-4)" }}>
        <section className="panel" id="files-add">
          <div className="panel-header">
            <span className="panel-title">{t("files.addTitle")}</span>
          </div>
          <div
            className="panel-body toolbar toolbar--fields"
            style={{ flexWrap: "wrap", gap: "var(--sp-2)" }}
          >
            <div className="field">
              <label htmlFor="files-kind">{t("files.kind")}</label>
              <select
                id="files-kind"
                className="select"
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value === "folder" ? "folder" : "file")
                }
              >
                <option value="file">{t("files.kindFile")}</option>
                <option value="folder">{t("files.kindFolder")}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="files-attach">{t("files.attachProject")}</label>
              <select
                id="files-attach"
                className="select"
                value={attachTo}
                onChange={(event) => setAttachTo(event.target.value)}
              >
                <option value="">{t("files.noProject")}</option>
                {activeProjects.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label htmlFor="files-path">{t("files.path")}</label>
              <input
                id="files-path"
                ref={pathInputRef}
                className="input mono"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addResource();
                }}
                placeholder={t("files.pathPlaceholder")}
              />
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void browse(kind === "folder")}
            >
              <FolderSearch size={14} aria-hidden />{" "}
              {kind === "folder" ? t("files.browseFolder") : t("files.browseFile")}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!path.trim()}
              onClick={() => addResource()}
            >
              <Plus size={14} aria-hidden /> {t("files.add")}
            </button>
          </div>
          <p
            className="muted"
            style={{
              margin: "0 var(--sp-3) var(--sp-3)",
              fontSize: "var(--fs-12)",
            }}
          >
            {t("files.addHint")}
          </p>
        </section>

        {files.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title={t("files.empty")}
            hint={t("files.emptyHint")}
            action={
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => {
                  if (canPick) void browse(false);
                  else focusAddForm();
                }}
              >
                {t("files.emptyAction")}
              </button>
            }
          />
        ) : (
          <div className="panel">
            <div className="row-list">
              {files.map((resource) => {
                const Icon = resource.kind === "folder" ? Folder : File;
                const project = workspaces.find(
                  (workspace) => workspace.id === resource.workspaceId,
                );
                return (
                  <div key={resource.id} className="row" style={{ cursor: "default" }}>
                    <Icon size={16} aria-hidden />
                    <span className="truncate" style={{ flex: 1, textAlign: "left" }}>
                      <strong>{resource.title}</strong>
                      <span className="faint mono" style={{ display: "block" }}>
                        {resource.target}
                      </span>
                    </span>
                    {project && (
                      <span className="badge badge--neutral">{project.name}</span>
                    )}
                    <button
                      type="button"
                      className="btn btn--icon btn--sm"
                      aria-label={`${t("action.open")}: ${resource.title}`}
                      onClick={() => void openResource(resource)}
                    >
                      <ExternalLink size={14} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="btn btn--icon btn--sm"
                      aria-label={`${t("action.delete")}: ${resource.title}`}
                      onClick={() => void removeResource(resource)}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
