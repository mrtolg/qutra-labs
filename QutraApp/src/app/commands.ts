import { LAB_VIEWS, TOOLS_VIEWS } from "@/domain/workbench";
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "@/features/settings/sections";
import type { MessageKey } from "@/lib/i18n/en";

/* The command registry: everything the palette can reach (docs/design/shell-spec.md §4).
   Once the rail replaces the sidebar, a place that is not listed here is
   reachable only by mouse, if at all — `commands.test.ts` fails when a route,
   investigation section, Tools section or Settings section is missing.
   Single tools join once every registered tool has a launch capability. */

export type PaletteGroup = "goto" | "actions" | "lab" | "tools" | "settings";

export type PaletteAction =
  | "new-session"
  | "capture"
  | "new-terminal"
  | "new-engagement"
  | "toggle-context-panel"
  | "open-settings";

export interface PaletteTarget {
  /** Stable: persisted in the Recent list. */
  id: string;
  group: PaletteGroup;
  labelKey: MessageKey;
  keywords: string;
  /** Exactly one of these: a route to go to, an action handler to run, or
      a Settings section to open in the Settings modal (never a route). */
  to?: string;
  action?: PaletteAction;
  settings?: SettingsSection;
}

export const PALETTE_GROUPS: readonly [PaletteGroup, MessageKey][] = [
  ["goto", "palette.navigation"],
  ["actions", "palette.commands"],
  ["lab", "topbar.lab"],
  ["tools", "topbar.tools"],
  ["settings", "settings.title"],
];

const GO_TO: readonly [string, MessageKey, string][] = [
  ["/overview", "nav.overview", "home dashboard ana sayfa"],
  ["/terminal", "nav.terminal", "work terminal shell"],
  ["/jarvis", "nav.jarvis", "assistant chat ai"],
  ["/lab", "nav.securityLab", "investigations incelemeler lab laboratory"],
  ["/workspaces", "nav.projects", "projects workspaces"],
  ["/files", "nav.files", "files documents"],
  ["/tools", "nav.tools", "tools utilities"],
  ["/github", "nav.git", "github git repositories"],
];

const ACTIONS: readonly [PaletteAction, MessageKey, string][] = [
  ["new-session", "today.newSession", "session start focus oturum odak"],
  ["capture", "today.captureContext", "snapshot capture context"],
  ["new-terminal", "terminal.newTab", "terminal shell tab new"],
  ["new-engagement", "lab.newEngagement", "investigation inceleme engagement lab new"],
  ["toggle-context-panel", "palette.toggleContext", "context panel project files repo runs output bağlam"],
  ["open-settings", "settings.title", "settings preferences ayarlar"],
];

export const PALETTE_TARGETS: readonly PaletteTarget[] = [
  ...GO_TO.map(([to, labelKey, keywords]) => ({
    id: `nav:${to}`,
    group: "goto" as const,
    labelKey,
    keywords,
    to,
  })),
  ...ACTIONS.map(([action, labelKey, keywords]) => ({
    id: `cmd:${action}`,
    group: "actions" as const,
    labelKey,
    keywords,
    action,
  })),
  ...LAB_VIEWS.map((view) => ({
    id: `nav:/lab?view=${view}`,
    group: "lab" as const,
    labelKey: `lab.view.${view}` as MessageKey,
    keywords: `lab ${view}`,
    to: `/lab?view=${view}`,
  })),
  // The Tools sections; the guides (catalog, playbooks, datasets) moved here
  // out of the investigation (spec 2026-10-07 §5.1).
  ...TOOLS_VIEWS.map((view) => ({
    id: `nav:/tools?view=${view}`,
    group: "tools" as const,
    labelKey: `tools.view.${view}` as MessageKey,
    keywords: `tools araçlar ${view}`,
    to: `/tools?view=${view}`,
  })),
  ...SETTINGS_SECTIONS.map((section) => ({
    id: `settings:${section}`,
    group: "settings" as const,
    labelKey: `settings.${section}` as MessageKey,
    keywords: `settings ${section}`,
    settings: section,
  })),
];
