import type { MessageKey } from "@/lib/i18n/en";
import { LAB_VIEWS, TOOLS_VIEWS } from "@/domain/workbench";

/* The shortcut registry: every keyboard shortcut the app answers, its default
   binding, and the rules a new binding must pass. The one key handler
   (app/useShortcuts) and Settings › Shortcuts both read it; a user's changes
   are stored as overrides in preferences.shortcutBindings.

   A binding is a canonical string: modifiers in the order Ctrl, Alt, Shift,
   Meta, then one key token ("Ctrl+Shift+T", "Alt+1", "F5"). Letters are upper
   case; digits come from the key's position, so Ctrl+1 is the same on every
   layout. */

export type ShortcutGroup = "navigation" | "jarvis" | "lab" | "terminal" | "general";

export const SHORTCUT_GROUPS: readonly { id: ShortcutGroup; labelKey: MessageKey }[] = [
  { id: "navigation", labelKey: "shortcuts.group.navigation" },
  { id: "jarvis", labelKey: "shortcuts.group.jarvis" },
  { id: "lab", labelKey: "shortcuts.group.lab" },
  { id: "terminal", labelKey: "shortcuts.group.terminal" },
  { id: "general", labelKey: "shortcuts.group.general" },
];

export interface ShortcutDef {
  id: string;
  group: ShortcutGroup;
  labelKey: MessageKey;
  /** Shown before the label ("Tools › Catalog"), for a section of an area. */
  areaKey?: MessageKey;
  defaultBinding: string | null;
}

const LAB_VIEW_KEYS: Record<(typeof LAB_VIEWS)[number], string | null> = {
  overview: "Alt+1",
  targets: "Alt+2",
  runs: "Alt+3",
  evidence: "Alt+4",
  findings: "Alt+5",
  report: "Alt+6",
  scope: null,
};

export const SHORTCUTS: readonly ShortcutDef[] = [
  // Navigation: Home, Tools, and the sections of each.
  { id: "go.home", group: "navigation", labelKey: "shortcuts.action.openHome", defaultBinding: "Alt+Home" },
  { id: "go.tools", group: "navigation", labelKey: "shortcuts.action.openTools", defaultBinding: "Ctrl+2" },
  { id: "section.next", group: "navigation", labelKey: "shortcuts.action.nextSection", defaultBinding: "Ctrl+PageDown" },
  { id: "section.prev", group: "navigation", labelKey: "shortcuts.action.prevSection", defaultBinding: "Ctrl+PageUp" },
  { id: "go.workspaces", group: "navigation", labelKey: "nav.workspaces", areaKey: "nav.overview", defaultBinding: null },
  { id: "go.files", group: "navigation", labelKey: "nav.files", areaKey: "nav.overview", defaultBinding: null },
  { id: "go.github", group: "navigation", labelKey: "nav.github", areaKey: "nav.overview", defaultBinding: null },
  ...TOOLS_VIEWS.map((view) => ({
    id: `tools.view.${view}`,
    group: "navigation" as const,
    labelKey: `tools.view.${view}` as MessageKey,
    areaKey: "topbar.tools" as MessageKey,
    defaultBinding: null,
  })),
  // Jarvis
  { id: "go.jarvis", group: "jarvis", labelKey: "shortcuts.action.openJarvis", defaultBinding: "Ctrl+3" },
  { id: "jarvis.new", group: "jarvis", labelKey: "subnav.newConversation", defaultBinding: "Ctrl+Shift+O" },
  // Investigations
  { id: "go.lab", group: "lab", labelKey: "shortcuts.action.openLab", defaultBinding: "Ctrl+1" },
  { id: "lab.new", group: "lab", labelKey: "lab.newEngagement", defaultBinding: "Ctrl+Shift+N" },
  ...LAB_VIEWS.map((view) => ({
    id: `lab.view.${view}`,
    group: "lab" as const,
    labelKey: `lab.view.${view}` as MessageKey,
    defaultBinding: LAB_VIEW_KEYS[view],
  })),
  { id: "lab.import", group: "lab", labelKey: "lab.import", defaultBinding: null },
  // Terminal
  { id: "go.terminal", group: "terminal", labelKey: "shortcuts.action.openTerminal", defaultBinding: "Ctrl+4" },
  { id: "terminal.newTab", group: "terminal", labelKey: "terminal.newTab", defaultBinding: "Ctrl+Shift+T" },
  { id: "terminal.closeTab", group: "terminal", labelKey: "shortcuts.action.closeTab", defaultBinding: "Ctrl+Shift+W" },
  { id: "terminal.nextTab", group: "terminal", labelKey: "shortcuts.action.nextTab", defaultBinding: "Ctrl+Tab" },
  { id: "terminal.prevTab", group: "terminal", labelKey: "shortcuts.action.prevTab", defaultBinding: "Ctrl+Shift+Tab" },
  // General
  { id: "palette", group: "general", labelKey: "titlebar.commandPalette", defaultBinding: "Ctrl+K" },
  { id: "settings", group: "general", labelKey: "nav.settings", defaultBinding: "Ctrl+," },
  { id: "shortcuts", group: "general", labelKey: "shortcuts.action.showShortcuts", defaultBinding: "F1" },
  { id: "contextPanel", group: "general", labelKey: "ctx.toggle", defaultBinding: "Ctrl+B" },
  { id: "session.new", group: "general", labelKey: "today.newSession", defaultBinding: null },
  { id: "capture", group: "general", labelKey: "today.captureContext", defaultBinding: null },
  { id: "reload", group: "general", labelKey: "shortcuts.action.reload", defaultBinding: "Ctrl+Shift+R" },
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

export function shortcutDef(id: string): ShortcutDef | undefined {
  return BY_ID.get(id);
}

/* ---------- Bindings ---------- */

export type Overrides = Record<string, string | null>;
/** Every shortcut's current binding (null: none). */
export type BindingMap = Record<string, string | null>;

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
const NAMED_KEYS = new Set([
  "Enter", "Tab", "Space", "Backspace", "Delete", "Insert", "Escape",
  "Home", "End", "PageUp", "PageDown", "Plus",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
]);

/** True for a well-formed canonical binding. */
export function isBinding(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return false;
  const parts = value.split("+");
  const key = parts.pop();
  if (!key) return false;
  let last = -1;
  for (const mod of parts) {
    const at = (MODIFIERS as readonly string[]).indexOf(mod);
    if (at <= last) return false;
    last = at;
  }
  return NAMED_KEYS.has(key) || /^Num[0-9]$/.test(key) || ([...key].length === 1 && key !== "+");
}

/** Defaults with the user's overrides on top; malformed overrides are ignored. */
export function effectiveBindings(overrides: Overrides | undefined): BindingMap {
  const map: BindingMap = {};
  for (const def of SHORTCUTS) {
    const own = overrides?.[def.id];
    map[def.id] =
      own === null ? null : own !== undefined && isBinding(own) ? own : def.defaultBinding;
  }
  return map;
}

/** Binding → shortcut id, for the key handler. The first shortcut wins a tie. */
export function bindingIndex(map: BindingMap): Map<string, string> {
  const index = new Map<string, string>();
  for (const def of SHORTCUTS) {
    const binding = map[def.id];
    if (binding && !index.has(binding)) index.set(binding, def.id);
  }
  return index;
}

const SHIFTED_CODES: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Minus: "-", Equal: "=", Semicolon: ";",
  Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Backquote: "`",
};

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** The binding a key press makes, or null while only modifiers are held. */
export function eventToBinding(e: KeyLike): string | null {
  const { key, code } = e;
  if (!key || ["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Dead", "Unidentified", "Process"].includes(key)) {
    return null;
  }
  let token: string;
  if (/^Digit[0-9]$/.test(code)) token = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) token = `Num${code.slice(6)}`;
  else if (e.shiftKey && /^Key[A-Z]$/.test(code)) token = code.slice(3);
  else if (e.shiftKey && SHIFTED_CODES[code]) token = SHIFTED_CODES[code];
  else if (key === " ") token = "Space";
  else if (key === "+") token = "Plus";
  else if (key === "Esc") token = "Escape";
  else if ([...key].length === 1) token = key.toUpperCase();
  else if (NAMED_KEYS.has(key)) token = key;
  else return null;
  const mods = [
    e.ctrlKey && "Ctrl",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
    e.metaKey && "Meta",
  ].filter(Boolean);
  return [...mods, token].join("+");
}

/** The keys of a binding, one keycap each. */
export function bindingKeys(binding: string): string[] {
  return binding.split("+");
}

const KEY_LABEL: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  PageUp: "PgUp", PageDown: "PgDn", Escape: "Esc", Delete: "Del", Insert: "Ins",
  Backspace: "⌫", Meta: "Win", Plus: "+",
};

/** How a key is printed on its keycap. */
export function keyLabel(key: string): string {
  return KEY_LABEL[key] ?? key;
}

/** A binding as plain text ("Ctrl+Shift+T"), for titles and messages. */
export function bindingText(binding: string): string {
  return bindingKeys(binding).map(keyLabel).join("+");
}

const ARIA_KEY: Record<string, string> = {
  Ctrl: "Control", ",": "Comma", ".": "Period", "/": "Slash",
  "-": "Minus", "=": "Equal", Space: "Space",
};

/** The binding as an aria-keyshortcuts value ("Control+Comma"). */
export function ariaKeyshortcuts(binding: string | null): string | undefined {
  if (!binding) return undefined;
  return bindingKeys(binding).map((k) => ARIA_KEY[k] ?? k).join("+");
}

/* ---------- Rules for a new binding ---------- */

/** Why a binding cannot be assigned at all. */
export type BindingBlock =
  /** Needs Ctrl or Alt (or is a function key): a plain key would fire while typing. */
  | { kind: "needsModifier" }
  /** Windows keeps it for itself, so the app never sees it. */
  | { kind: "system"; reasonKey: MessageKey };

/** What assigning a binding would take away; the user confirms first. */
export interface BindingWarnings {
  /** Text editing or the browser view loses this combination. */
  reservedKey?: MessageKey;
  /** The shortcut that has it now and would be left without one. */
  takenBy?: string;
}

export type BindingCheck =
  | { ok: false; block: BindingBlock }
  | { ok: true; warnings: BindingWarnings };

const SYSTEM: Record<string, MessageKey> = {
  "Alt+F4": "shortcuts.reserved.closeWindow",
  "Alt+Tab": "shortcuts.reserved.switchWindow",
  "Alt+Shift+Tab": "shortcuts.reserved.switchWindow",
  "Alt+Space": "shortcuts.reserved.windowMenu",
  "Alt+Escape": "shortcuts.reserved.switchWindow",
  "Ctrl+Escape": "shortcuts.reserved.startMenu",
  "Ctrl+Shift+Escape": "shortcuts.reserved.taskManager",
  "Ctrl+Alt+Delete": "shortcuts.reserved.securityScreen",
};

const EDITING: string[] = ["A", "C", "V", "X", "Z", "Y"];
const VIEW: Record<string, MessageKey> = {
  "Ctrl+R": "shortcuts.reserved.reload",
  F5: "shortcuts.reserved.reload",
  "Ctrl+F5": "shortcuts.reserved.reload",
  "Ctrl+F": "shortcuts.reserved.find",
  "Ctrl+P": "shortcuts.reserved.print",
  "Ctrl+Shift+I": "shortcuts.reserved.devtools",
  "Ctrl+Shift+J": "shortcuts.reserved.devtools",
  F12: "shortcuts.reserved.devtools",
  "Ctrl+=": "shortcuts.reserved.zoom",
  "Ctrl+-": "shortcuts.reserved.zoom",
  "Ctrl+0": "shortcuts.reserved.zoom",
  "Ctrl+Shift+=": "shortcuts.reserved.zoom",
  F11: "shortcuts.reserved.fullScreen",
};

/** Whether `id` may take `binding`, and what it would take away. */
export function checkBinding(id: string, binding: string, map: BindingMap): BindingCheck {
  const keys = bindingKeys(binding);
  const key = keys[keys.length - 1];
  const has = (mod: string) => keys.slice(0, -1).includes(mod);
  if (has("Meta")) return { ok: false, block: { kind: "system", reasonKey: "shortcuts.reserved.windowsKey" } };
  if (SYSTEM[binding]) return { ok: false, block: { kind: "system", reasonKey: SYSTEM[binding] } };
  if (!has("Ctrl") && !has("Alt") && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    return { ok: false, block: { kind: "needsModifier" } };
  }
  const warnings: BindingWarnings = {};
  if (VIEW[binding]) warnings.reservedKey = VIEW[binding];
  else if (binding === `Ctrl+${key}` && EDITING.includes(key)) {
    warnings.reservedKey = "shortcuts.reserved.editing";
  } else if (has("Ctrl") && has("Alt") && !has("Shift") && [...key].length === 1) {
    // Ctrl+Alt is AltGr on many layouts: on a Turkish keyboard AltGr+Q types @.
    warnings.reservedKey = "shortcuts.reserved.altGr";
  }
  const other = SHORTCUTS.find((def) => def.id !== id && map[def.id] === binding);
  if (other) warnings.takenBy = other.id;
  return { ok: true, warnings };
}

/** The overrides after giving `id` the binding (null: none), freeing it elsewhere. */
export function assignBinding(overrides: Overrides, id: string, binding: string | null): Overrides {
  const map = effectiveBindings(overrides);
  const next: Overrides = { ...overrides };
  if (binding) {
    for (const def of SHORTCUTS) {
      if (def.id !== id && map[def.id] === binding) {
        next[def.id] = null;
      }
    }
  }
  const def = shortcutDef(id);
  if (def && binding === def.defaultBinding) delete next[id];
  else next[id] = binding;
  return tidy(next);
}

/** The overrides with `id` back on its default. Another shortcut holding that default loses it. */
export function resetBinding(overrides: Overrides, id: string): Overrides {
  const def = shortcutDef(id);
  if (!def) return overrides;
  return assignBinding(overrides, id, def.defaultBinding);
}

/** Drop overrides that only repeat a default. */
function tidy(overrides: Overrides): Overrides {
  const out: Overrides = {};
  for (const [id, binding] of Object.entries(overrides)) {
    const def = shortcutDef(id);
    if (def && binding !== def.defaultBinding) out[id] = binding;
  }
  return out;
}
