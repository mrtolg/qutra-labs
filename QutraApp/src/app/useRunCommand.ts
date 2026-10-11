import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import { useCollection, usePreferences } from "@/lib/db/database";
import { getBridge } from "@/lib/bridge";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import type { PaletteAction } from "./commands";
import { toggleContextPanel } from "./context/panelState";

/**
 * The one handler for every command action, shared by the palette, the
 * shortcuts and Home: a second entry point must not grow its own, looser copy
 * of the guards below.
 */
export function useRunCommand(): (action: PaletteAction) => void {
  const { t } = useT();
  const navigate = useNavigate();
  const prefs = usePreferences();
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const announce = useUi((s) => s.announce);
  const workspaces = useCollection("workspaces");

  /* Both of these need a workspace to act on, so they resolve one the same way
     the rest of the shell does: whatever is active, else the most recently
     touched non-archived project.

     They used to be near no-ops — "New session" only opened the project list,
     and "Capture context" navigated to `?capture=1`, a parameter nothing read.
     Both looked like they had worked. Now they deep-link to the page that owns
     the real dialog and open it; with no project to act on they say so instead
     of pretending. */
  const targetWorkspaceId = useMemo(() => {
    if (activeWorkspaceId) return activeWorkspaceId;
    return (
      [...workspaces]
        .filter((w) => w.status !== "archived")
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]?.id ?? null
    );
  }, [activeWorkspaceId, workspaces]);

  return useCallback(
    (action: PaletteAction) => {
      if (action === "new-session" || action === "capture") {
        if (!targetWorkspaceId) {
          // No project exists yet — send the user where one is created, and
          // be explicit that nothing was started.
          navigate("/workspaces");
          announce(t("palette.needsProject"));
          return;
        }
        const param = action === "new-session" ? "start-session" : "capture";
        navigate(`/workspaces/${targetWorkspaceId}?action=${param}`);
      } else if (action === "new-terminal") {
        // A shell tab only where one can run. Otherwise Work itself says why
        // (browser build, or Private Lab not enabled) — never a fake tab.
        if (getBridge().terminal.available() && prefs.privateToolsEnabled) {
          useTerminalTabs.getState().openShellTab("pwsh");
        }
        navigate("/terminal");
      } else if (action === "toggle-context-panel") {
        toggleContextPanel();
      } else if (action === "new-engagement") {
        // The Lab asks for the name and folder first; nothing is made until then.
        navigate("/lab?new=1");
      } else if (action === "open-settings") {
        useUi.getState().openSettings();
      }
    },
    [targetWorkspaceId, navigate, announce, t, prefs.privateToolsEnabled],
  );
}
