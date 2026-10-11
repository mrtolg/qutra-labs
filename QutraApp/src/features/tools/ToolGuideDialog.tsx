import { Link } from "react-router-dom";
import { BookOpen, ExternalLink, ShieldCheck, TerminalSquare } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { getBridge } from "@/lib/bridge";
import { useT } from "@/lib/i18n";
import { toolsHref } from "@/domain/workbench";
import type { LauncherTile } from "@/domain/tools/launcherGrid";
import { TOOL_CATALOG as GUIDES, localizeText } from "@/features/lab/toolCatalog";
import { getPrivateLabCopy, getToolUsageGuide } from "@/features/lab/toolGuidesData";
import { ToolLogo } from "./logos/ToolLogo";

/** Registry adapters with no guide of their own read the guide of the
    product they ship with. */
const GUIDE_FALLBACK: Record<string, string> = {
  tshark: "wireshark",
  yara: "yara-rules",
};

export function guideFor(tile: LauncherTile) {
  const id = tile.guideId ?? GUIDE_FALLBACK[tile.catalogId];
  return id ? GUIDES.find((guide) => guide.id === id) : undefined;
}

/**
 * Kılavuz: what the tool is for and how a first run goes, without leaving the
 * toolbox. The whole guide, with its install details, stays in the Catalog.
 */
export function ToolGuideDialog({
  tile,
  purpose,
  onClose,
}: {
  tile: LauncherTile | null;
  purpose: string;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  const copy = getPrivateLabCopy(locale);
  const entry = tile ? guideFor(tile) : undefined;
  const guide = entry ? getToolUsageGuide(entry) : undefined;
  return (
    <Dialog
      open={tile !== null}
      onClose={onClose}
      wide
      title={tile ? t("launcher.guideTitle", { tool: tile.name }) : ""}
      footer={
        tile && (
          <>
            {tile.downloadUrl && (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void getBridge().openUrl(tile.downloadUrl)}
              >
                <ExternalLink size={14} aria-hidden /> {t("launcher.officialPage")}
              </button>
            )}
            {entry && (
              <Link className="btn btn--secondary" to={toolsHref("catalog", null, entry.id)} onClick={onClose}>
                <BookOpen size={14} aria-hidden /> {t("launcher.openInCatalog")}
              </Link>
            )}
            <button type="button" className="btn btn--primary" onClick={onClose}>
              {t("action.close")}
            </button>
          </>
        )
      }
    >
      {tile && (
        <div className="tbx-guide">
          <div className="tbx-guide__lead">
            <ToolLogo name={tile.name} catalogId={tile.catalogId} category={tile.category} size={44} />
            <p>{purpose}</p>
          </div>
          {guide ? (
            <>
              <section>
                <h3>
                  <TerminalSquare size={14} aria-hidden /> {copy.starterWorkflow}
                </h3>
                <p>{localizeText(guide.goal, locale)}</p>
                {guide.command && (
                  <div className="tbx-guide__command">
                    <span>{copy.commandPreview}</span>
                    <code>{guide.command}</code>
                  </div>
                )}
              </section>
              <section className="tbx-guide__columns">
                <div>
                  <h3>{copy.requiredInputs}</h3>
                  <ul>
                    {guide.inputs.map((item) => (
                      <li key={item.en}>{localizeText(item, locale)}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3>{copy.expectedOutput}</h3>
                  <ul>
                    {guide.expected.map((item) => (
                      <li key={item.en}>{localizeText(item, locale)}</li>
                    ))}
                  </ul>
                </div>
              </section>
              <section>
                <h3>{copy.workflowSteps}</h3>
                <ol>
                  {guide.steps.map((step) => (
                    <li key={step.en}>{localizeText(step, locale)}</li>
                  ))}
                </ol>
              </section>
              <section className="tbx-guide__boundary">
                <h3>
                  <ShieldCheck size={14} aria-hidden /> {copy.safetyBoundary}
                </h3>
                <p>{localizeText(guide.boundary, locale)}</p>
              </section>
            </>
          ) : (
            <p className="muted">{t("launcher.guideOfficialOnly")}</p>
          )}
        </div>
      )}
    </Dialog>
  );
}
