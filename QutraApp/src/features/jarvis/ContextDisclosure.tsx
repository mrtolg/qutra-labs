import { useRef } from "react";
import { Layers } from "lucide-react";
import type { ContextSummaryLine } from "@/domain/assistantContext";
import { getDb, useCollection, usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import { useDetailsDismiss } from "./useDetailsDismiss";

/**
 * Honest disclosure of the context that rides along with the next turn: the
 * exact rows, the project they come from, and a switch to stop it. Not a
 * dashboard: a list of what leaves this screen. It opens above the composer.
 */
export function ContextDisclosure({
  context,
  projectId,
}: {
  context: { summary: readonly ContextSummaryLine[]; truncated: boolean };
  projectId: string;
}) {
  const { t } = useT();
  const prefs = usePreferences();
  const db = getDb();
  const workspaces = useCollection("workspaces");
  const setActiveWorkspace = useUi((s) => s.setActiveWorkspace);
  const ref = useRef<HTMLDetailsElement>(null);

  useDetailsDismiss(ref);

  const count = context.summary.length;
  const label = !prefs.assistantContextEnabled
    ? t("qutra.contextOff")
    : count > 0
      ? t("qutra.contextAttached", { count })
      : t("ctx.title");
  // With nothing attached the chip is just the icon, not a count of nothing.
  const showText = !prefs.assistantContextEnabled || count > 0;

  return (
    <details
      ref={ref}
      className={showText ? "asst-context" : "asst-context asst-context--icon"}
      data-testid="qutra-context"
    >
      <summary
        className="asst-chip asst-chip--btn"
        aria-label={label}
        title={label}
      >
        <Layers size={12} aria-hidden />
        {showText && label}
      </summary>

      <div className="asst-context__pop">
        <label className="asst-context__toggle">
          <input
            type="checkbox"
            checked={prefs.assistantContextEnabled}
            onChange={(e) => db.prefs.set({ assistantContextEnabled: e.target.checked })}
            data-testid="qutra-context-toggle"
          />
          <span>{t("qutra.contextToggle")}</span>
        </label>

        {prefs.assistantContextEnabled && (
          <div className="field">
            <label htmlFor="jarvis-project">{t("jarvis.project")}</label>
            <select
              id="jarvis-project"
              className="select"
              value={projectId}
              onChange={(event) => setActiveWorkspace(event.target.value || null)}
            >
              <option value="">{t("jarvis.selectProject")}</option>
              {workspaces
                .filter((workspace) => workspace.status !== "archived")
                .map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
            </select>
          </div>
        )}

        {prefs.assistantContextEnabled && context.summary.length === 0 && (
          <p className="asst-small faint">{t("qutra.contextEmpty")}</p>
        )}

        {prefs.assistantContextEnabled && context.summary.length > 0 && (
          <ul className="asst-context__rows">
            {context.summary.map((row, i) => (
              <li key={i}>
                <span className="faint">{row.label}:</span> {row.value}
              </li>
            ))}
          </ul>
        )}

        {context.truncated && <p className="asst-small faint">{t("qutra.contextTruncated")}</p>}

        <p className="asst-small faint">{t("qutra.contextReadOnly")}</p>
      </div>
    </details>
  );
}
