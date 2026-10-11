import { GitBranch } from "lucide-react";
import { useT } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import { ContextEmpty } from "./ContextEmpty";
import { NoProject } from "./ProjectSegment";
import { useActiveProject } from "./useActiveProject";

/**
 * Repo: the active project's recorded Git state — branch, changed
 * files, ahead/behind and recent commits. Qutra has no native Git reader yet
 * (`gitInspection` is not implemented), so there is no "Inspect" button that
 * could not act; without recorded state the segment says so.
 */
export function RepoSegment() {
  const { t, locale } = useT();
  const { project } = useActiveProject();

  if (!project) return <NoProject />;
  const git = project.git?.connected ? project.git : undefined;

  if (!git) {
    return (
      <ContextEmpty
        icon={GitBranch}
        title={t("ctx.repo.noneTitle")}
        hint={
          project.localPath
            ? t("ctx.repo.noneHint", { path: project.localPath })
            : t("ctx.repo.noFolder")
        }
      />
    );
  }

  return (
    <div className="ctx-repo">
      <div className="ctx-repo__head">
        <span className="ctx-ricon" aria-hidden>
          <GitBranch size={15} />
        </span>
        <div className="ctx-row__main">
          <strong>{project.name}</strong>
          {project.localPath && (
            <small className="mono ctx-trunc" title={project.localPath}>
              {project.localPath}
            </small>
          )}
        </div>
      </div>
      <dl className="ctx-repo__stats">
        <div>
          <dt>{t("ctx.repo.branch")}</dt>
          <dd className="mono">{git.branch ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("ctx.repo.changed")}</dt>
          <dd className="mono">{git.dirtyFiles}</dd>
        </div>
        <div>
          <dt>{t("ctx.repo.remote")}</dt>
          <dd>{t("ws.aheadBehind", { ahead: git.ahead, behind: git.behind })}</dd>
        </div>
      </dl>
      <section className="ctx-sec">
        <h3 className="ctx-lbl">{t("ctx.repo.commits")}</h3>
        {git.lastCommits.length === 0 ? (
          <p className="ctx-faint">{t("ctx.repo.noCommits")}</p>
        ) : (
          <ul className="ctx-commits">
            {git.lastCommits.map((c) => (
              <li key={c.hash}>
                <span className="mono ctx-commits__hash">{c.hash.slice(0, 7)}</span>
                <span className="ctx-row__main">
                  <span className="ctx-trunc">{c.message}</span>
                  <small>
                    {c.author} · {formatRelative(c.at, locale)}
                    {(c.additions > 0 || c.deletions > 0) && (
                      <>
                        {" · "}
                        <span className="ctx-add-n">+{c.additions}</span>{" "}
                        <span className="ctx-del-n">−{c.deletions}</span>
                      </>
                    )}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
