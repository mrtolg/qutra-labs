import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getDb, usePreferences } from "@/lib/db/database";
import { createConversation } from "@/lib/db/conversations";
import { latestConversation } from "@/domain/conversations";
import {
  LAB_VIEWS,
  TOOLS_VIEWS,
  resolveLabView,
  resolveToolsView,
  toolsHref,
  type LabView,
  type ToolsView,
} from "@/domain/workbench";
import {
  bindingIndex,
  effectiveBindings,
  eventToBinding,
  type BindingMap,
} from "@/lib/shortcuts";
import { useUi } from "@/state/ui";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import { toggleContextPanel } from "./context/panelState";
import { areaFor } from "./surfaces";
import { useRunCommand } from "./useRunCommand";
import { LAB_VIEW_DEFS } from "./workbench/navConfig";

/** Every shortcut's current binding: the defaults with the user's changes. */
export function useShortcutBindings(): BindingMap {
  const overrides = usePreferences().shortcutBindings;
  return useMemo(() => effectiveBindings(overrides), [overrides]);
}

const HOME_SECTIONS = ["/overview", "/workspaces", "/files", "/github"] as const;
// The investigation's tabs; Scope opens from its strip, not from a tab.
const LAB_TABS: readonly LabView[] = LAB_VIEW_DEFS.map((d) => d.view);

/**
 * The app's one keyboard-shortcut handler: it reads the bindings from
 * the registry in lib/shortcuts, so a binding changed in Settings › Shortcuts
 * takes effect at once. It listens in the capture phase, because the terminal
 * swallows most keys, and steps aside where a key belongs to someone else:
 * a plain Ctrl+letter in the terminal goes to the shell, a pane marked
 * `data-holds-keys` keeps all but the area switches and the context panel,
 * and while a modal is open only the palette may close itself.
 */
export function useShortcuts(): void {
  const navigate = useNavigate();
  const location = useLocation();
  const runCommand = useRunCommand();
  const bindings = useShortcutBindings();
  const index = useMemo(() => bindingIndex(bindings), [bindings]);
  const where = useRef(location);
  where.current = location;

  const run = useCallback(
    (id: string): boolean => {
      const { pathname, search } = where.current;
      const params = new URLSearchParams(search);
      const engagement = params.get("e");
      const area = areaFor(pathname);
      const ui = useUi.getState();
      const terminal = useTerminalTabs.getState();
      const onTerminal = area === "terminal";

      if (id.startsWith("lab.view.")) {
        const view = id.slice("lab.view.".length) as LabView;
        if (!(LAB_VIEWS as readonly string[]).includes(view)) return false;
        navigate(engagement ? `/lab?e=${encodeURIComponent(engagement)}&view=${view}` : `/lab?view=${view}`);
        return true;
      }
      if (id.startsWith("tools.view.")) {
        const view = id.slice("tools.view.".length) as ToolsView;
        if (!(TOOLS_VIEWS as readonly string[]).includes(view)) return false;
        navigate(toolsHref(view, engagement));
        return true;
      }

      switch (id) {
        case "go.home":
          navigate("/overview");
          return true;
        case "go.lab":
          navigate("/lab");
          return true;
        case "go.tools":
          navigate("/tools");
          return true;
        case "go.jarvis":
          navigate("/jarvis");
          return true;
        case "go.terminal":
          navigate("/terminal");
          return true;
        case "go.workspaces":
          navigate("/workspaces");
          return true;
        case "go.files":
          navigate("/files");
          return true;
        case "go.github":
          navigate("/github");
          return true;
        case "section.next":
        case "section.prev": {
          const step = id === "section.next" ? 1 : -1;
          const cycle = <T,>(list: readonly T[], at: number) =>
            list[(Math.max(at, 0) + step + list.length) % list.length];
          if (area === "home") {
            const segment = `/${pathname.split("/")[1] ?? ""}`;
            const at = HOME_SECTIONS.findIndex((s) => s === segment || (s === "/workspaces" && segment === "/sessions"));
            navigate(cycle(HOME_SECTIONS, at));
            return true;
          }
          if (area === "lab" && engagement) {
            const view = cycle(LAB_TABS, LAB_TABS.indexOf(resolveLabView(params.get("view"))));
            navigate(`/lab?e=${encodeURIComponent(engagement)}&view=${view}`);
            return true;
          }
          if (area === "tools") {
            const view = cycle(TOOLS_VIEWS, TOOLS_VIEWS.indexOf(resolveToolsView(params.get("view"))));
            navigate(toolsHref(view, engagement));
            return true;
          }
          return false;
        }
        case "jarvis.new": {
          navigate("/jarvis");
          // One empty conversation about nothing is enough to start from.
          const shown = latestConversation(getDb().collection("conversations").getAll());
          if (shown && shown.messages.length === 0 && !shown.engagementId && !shown.workspaceId) return true;
          createConversation(getDb()).catch((caught: unknown) =>
            console.error("conversation not created", caught),
          );
          return true;
        }
        case "lab.new":
          runCommand("new-engagement");
          return true;
        case "lab.import":
          navigate(
            engagement
              ? `/lab?e=${encodeURIComponent(engagement)}&view=findings&focus=import`
              : "/lab",
          );
          return true;
        case "terminal.newTab":
          runCommand("new-terminal");
          return true;
        case "terminal.closeTab":
          // Closing ends the shell in it, so only where the tab is in view.
          if (!onTerminal || !terminal.activeId) return false;
          terminal.closeTab(terminal.activeId);
          return true;
        case "terminal.nextTab":
        case "terminal.prevTab": {
          if (!onTerminal || terminal.tabs.length < 2) return false;
          const at = terminal.tabs.findIndex((t) => t.id === terminal.activeId);
          const step = id === "terminal.nextTab" ? 1 : -1;
          const next = terminal.tabs[(at + step + terminal.tabs.length) % terminal.tabs.length];
          terminal.setActive(next.id);
          return true;
        }
        case "palette":
          ui.setPaletteOpen(!ui.paletteOpen);
          return true;
        case "settings":
          ui.openSettings();
          return true;
        case "shortcuts":
          ui.openSettings("shortcuts");
          return true;
        case "contextPanel":
          toggleContextPanel();
          return true;
        case "session.new":
          runCommand("new-session");
          return true;
        case "capture":
          runCommand("capture");
          return true;
        case "reload":
          // A reload ends every open shell; say so instead of doing it.
          if (terminal.tabs.length > 0) {
            ui.toast({ kind: "info", messageKey: "shortcuts.reloadBlocked" });
            return true;
          }
          window.location.reload();
          return true;
        default:
          return false;
      }
    },
    [navigate, runCommand],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return;
      const binding = eventToBinding(e);
      if (!binding) return;
      const id = index.get(binding);
      if (!id) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(".xterm") && /^Ctrl\+[A-Z]$/.test(binding)) return;
      // A pane that shows key presses (the keyboard viewer) holds them: only
      // the area switches and the context panel still work there, so the app
      // can always be left.
      if (target?.closest("[data-holds-keys]") && !id.startsWith("go.") && id !== "contextPanel") return;
      if (document.querySelector("dialog[open]")) {
        const ui = useUi.getState();
        if (id === "palette" && ui.paletteOpen) {
          e.preventDefault();
          ui.setPaletteOpen(false);
        }
        return;
      }
      if (!run(id)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, run]);
}
