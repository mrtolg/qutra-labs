/* Theme registry + resolution.
   Choices: System → Qutra Labs, Qutra Labs, High Contrast. Window effects
   (Mica, Acrylic, glass) are retired; a stored "windows" reads as Qutra Labs. */

import type { MessageKey } from "@/lib/i18n/en";

export type ThemeId = "contextos" | "highContrast";

/** What the `theme` preference may hold: a concrete theme or "system". */
export type ThemeSetting = ThemeId | "system";
export type ThemeMode = "light" | "dark" | "system" | "schedule";
export type ResolvedMode = "light" | "dark";

export interface ThemeMeta {
  id: ThemeId;
  nameKey: MessageKey;
  descKey: MessageKey;
  accentCustomizable: boolean;
  preferredMode: ResolvedMode;
}

export const THEMES: ThemeMeta[] = [
  {
    id: "contextos",
    nameKey: "theme.contextos",
    descKey: "theme.contextos.desc",
    accentCustomizable: true,
    preferredMode: "dark",
  },
  {
    id: "highContrast",
    nameKey: "theme.highContrast",
    descKey: "theme.highContrast.desc",
    accentCustomizable: false,
    preferredMode: "light",
  },
];

export const THEME_IDS: ThemeId[] = THEMES.map((t) => t.id);

/** Retired theme ids still present in some preference blobs. */
const LEGACY_THEME_MAP: Record<string, ThemeId> = {
  contextRose: "contextos",
  carbonSignal: "contextos",
  forestTerminal: "contextos",
  oceanPulse: "contextos",
  solarEmber: "contextos",
  acrylicClear: "contextos",
  liquidGlass: "contextos",
  windows: "contextos",
};

const isThemeId = (v: string): v is ThemeId =>
  (THEME_IDS as string[]).includes(v);

function normalizeThemeId(raw: string): ThemeId {
  if (isThemeId(raw)) return raw;
  return LEGACY_THEME_MAP[raw] ?? "contextos";
}

/** Parse "HH:MM" → minutes since midnight, or null. */
function parseClock(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Decide light/dark for a time-based schedule. Dark window runs
 *  [darkAt, lightAt); handles windows that cross midnight. */
export function scheduleMode(
  now: Date,
  lightAt: string | undefined,
  darkAt: string | undefined,
): ResolvedMode {
  const light = parseClock(lightAt) ?? 7 * 60;
  const dark = parseClock(darkAt) ?? 19 * 60;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (dark === light) return "light";
  const inDark =
    dark < light ? cur >= dark && cur < light : cur >= dark || cur < light;
  return inDark ? "dark" : "light";
}

export interface ResolveInput {
  theme: ThemeSetting | string;
  themeMode?: ThemeMode | string;
  themeScheduleLightAt?: string;
  themeScheduleDarkAt?: string;
  /** Settings › Increase contrast — forces the High Contrast theme. */
  highContrast?: boolean;
}

export interface ResolvedTheme {
  themeId: ThemeId;
  mode: ResolvedMode;
}

/**
 * Resolve the persisted preference (+ OS/clock) into a concrete
 * theme id and light/dark mode.
 */
export function resolveTheme(
  prefs: ResolveInput,
  osDark: boolean,
  now: Date = new Date(),
): ResolvedTheme {
  const raw = prefs.theme;

  let themeId: ThemeId;
  if (raw === "system" || raw === undefined) {
    themeId = "contextos";
  } else if (raw === "light" || raw === "dark") {
    themeId = "contextos";
  } else {
    themeId = normalizeThemeId(String(raw));
  }

  // Accessibility override wins over decorative selection.
  if (prefs.highContrast) {
    themeId = "highContrast";
  }

  let resolved: ResolvedMode;
  if (raw === "light") resolved = "light";
  else if (raw === "dark") resolved = "dark";
  else {
    const mode = prefs.themeMode ?? "system";
    if (mode === "light" || mode === "dark") resolved = mode;
    else if (mode === "schedule")
      resolved = scheduleMode(
        now,
        prefs.themeScheduleLightAt,
        prefs.themeScheduleDarkAt,
      );
    else resolved = osDark ? "dark" : "light";
  }

  // System theme always follows OS for mode (unless high-contrast pick uses explicit mode).
  if ((raw === "system" || raw === undefined) && !prefs.highContrast) {
    resolved = osDark ? "dark" : "light";
  }

  return { themeId, mode: resolved };
}

/** Apply the resolved theme to a root element (idempotent). */
export function applyThemeAttributes(
  root: { dataset: DOMStringMap },
  resolved: ResolvedTheme,
): void {
  root.dataset.theme = resolved.themeId;
  root.dataset.mode = resolved.mode;
}
