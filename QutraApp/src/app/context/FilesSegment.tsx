import { useMemo, useState } from "react";
import { ExternalLink, File, Folder, FolderSearch, Plus, Search, Trash2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useCollection } from "@/lib/db/database";
import { getBridge } from "@/lib/bridge";
import {
  addLinkedPath,
  openLinkedPath,
  removeLinkedPath,
} from "@/features/files/linkedPaths";
import { ContextEmpty } from "./ContextEmpty";
import { NoProject } from "./ProjectSegment";
import { useActiveProject } from "./useActiveProject";

/**
 * Files: the paths linked to the active project, newest first, with
 * search, open, remove and add. The same records as the Files page.
 */
export function FilesSegment() {
  const { t } = useT();
  const { project } = useActiveProject();
  const resources = useCollection("resources");
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const canPick = getBridge().capabilities().pickPath.available;

  const linked = useMemo(
    () =>
      resources
        .filter(
          (r) => (r.kind === "file" || r.kind === "folder") && r.workspaceId === project?.id,
        )
        .sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt)),
    [resources, project?.id],
  );
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle
    ? linked.filter(
        (r) =>
          r.title.toLocaleLowerCase().includes(needle) ||
          r.target.toLocaleLowerCase().includes(needle),
      )
    : linked;

  if (!project) return <NoProject />;

  const add = (target = path, kind: "file" | "folder" = "file") => {
    if (addLinkedPath(target, kind, project.id)) setPath("");
  };
  const browse = async (directory: boolean) => {
    const selected = await getBridge().pickPath({ directory });
    if (selected) add(selected, directory ? "folder" : "file");
  };

  return (
    <div className="ctx-files">
      <div className="ctx-field">
        <label className="ctx-lbl" htmlFor="ctx-files-search">
          {t("files.search")}
        </label>
        <div className="ctx-search">
          <Search size={14} aria-hidden />
          <input
            id="ctx-files-search"
            type="search"
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {linked.length > 0 && (
          <p className="ctx-faint">
            {t("ctx.files.count", { count: linked.length, project: project.name })}
          </p>
        )}
      </div>

      {linked.length === 0 ? (
        <ContextEmpty
          icon={File}
          title={t("ctx.files.emptyTitle")}
          hint={t("ctx.files.emptyHint")}
        />
      ) : shown.length === 0 ? (
        <p className="ctx-note">{t("ctx.files.noMatch", { query: query.trim() })}</p>
      ) : (
        <ul className="ctx-list ctx-paths">
          {shown.map((r) => {
            const Icon = r.kind === "folder" ? Folder : File;
            return (
              <li key={r.id} className="ctx-path">
                <span className="ctx-ricon" aria-hidden>
                  <Icon size={14} />
                </span>
                <span className="ctx-row__main">
                  <span className="ctx-trunc">{r.title}</span>
                  <small className="mono ctx-trunc" title={r.target}>
                    {r.target}
                  </small>
                </span>
                <span className="ctx-path__acts">
                  <button
                    type="button"
                    className="ctx-icon-btn"
                    onClick={() => void openLinkedPath(r)}
                    aria-label={`${t("action.open")} ${r.title}`}
                    title={t("action.open")}
                  >
                    <ExternalLink size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="ctx-icon-btn"
                    onClick={() => void removeLinkedPath(r)}
                    aria-label={`${t("action.remove")} ${r.title}`}
                    title={t("action.remove")}
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="ctx-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label className="ctx-lbl" htmlFor="ctx-files-add">
          {t("files.addTitle")}
        </label>
        <input
          id="ctx-files-add"
          className="input mono"
          value={path}
          placeholder={t("files.pathPlaceholder")}
          onChange={(e) => setPath(e.target.value)}
        />
        <div className="ctx-add__row">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => void browse(false)}
            disabled={!canPick}
          >
            <File size={13} aria-hidden /> {t("files.browseFile")}
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => void browse(true)}
            disabled={!canPick}
          >
            <FolderSearch size={13} aria-hidden /> {t("files.browseFolder")}
          </button>
          <span className="ctx-grow" />
          <button type="submit" className="btn btn--primary btn--sm" disabled={!path.trim()}>
            <Plus size={13} aria-hidden /> {t("files.add")}
          </button>
        </div>
        {!canPick && <p className="ctx-reason">{t("files.pickDesktopOnly")}</p>}
      </form>
    </div>
  );
}
