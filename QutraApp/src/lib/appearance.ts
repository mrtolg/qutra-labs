/* Appearance resolution: colour pack × light/dark mode. The window is always
   flat and opaque: the Mica, Acrylic and Liquid Glass options were removed
   (2026-10-10). A stored `material` or legacy `theme: "windows"` from
   an older version is still read, and reads as flat; it is never rewritten. */

import type { MessageKey } from "@/lib/i18n/en";
import { scheduleMode, type ResolvedMode, type ThemeMode } from "@/lib/theme";

export type PackId = "hud" | "contextos" | "catppuccin" | "highContrast";

export interface AppearanceCapabilities {
  highContrast: boolean;
  forcedColors: boolean;
}

export interface AppearanceInput {
  theme?: string;
  packId?: string;
  themeMode?: ThemeMode | string;
  themeScheduleLightAt?: string;
  themeScheduleDarkAt?: string;
  highContrast?: boolean;
  /** Legacy window effect from older versions; ignored. */
  material?: string;
}

export interface ResolvedAppearance {
  packId: PackId;
  /** CSS theme attribute — maps pack (+ HC override) onto existing token sheets. */
  themeAttr: string;
  mode: ResolvedMode;
  highContrast: boolean;
}

export const PACKS: { id: PackId; nameKey: MessageKey; descKey: MessageKey }[] = [
  {
    id: "hud",
    nameKey: "theme.hud",
    descKey: "theme.hud.desc",
  },
  {
    id: "contextos",
    nameKey: "theme.contextos",
    descKey: "theme.contextos.desc",
  },
  {
    id: "catppuccin",
    nameKey: "theme.catppuccin",
    descKey: "theme.catppuccin.desc",
  },
  {
    id: "highContrast",
    nameKey: "theme.highContrast",
    descKey: "theme.highContrast.desc",
  },
];

/** Read the stored pack, whatever version wrote it. */
export function migrateAppearanceIntent(prefs: AppearanceInput): {
  packId: PackId;
  highContrast: boolean;
} {
  const hc = Boolean(prefs.highContrast) || prefs.theme === "highContrast" || prefs.packId === "highContrast";
  if (hc) {
    return { packId: "highContrast", highContrast: true };
  }

  let packId: PackId = "hud";
  if (
    prefs.packId === "hud" ||
    prefs.packId === "catppuccin" ||
    prefs.packId === "contextos"
  ) {
    packId = prefs.packId;
  }
  return { packId, highContrast: false };
}

export function probeAppearanceCapabilities(): AppearanceCapabilities {
  const forced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(forced-colors: active)").matches;
  return { highContrast: forced, forcedColors: forced };
}

export function resolveMode(
  prefs: AppearanceInput,
  osDark: boolean,
  now: Date = new Date(),
): ResolvedMode {
  const raw = prefs.theme;
  if (raw === "light") return "light";
  if (raw === "dark") return "dark";
  const mode = prefs.themeMode ?? "system";
  if (mode === "light" || mode === "dark") return mode;
  if (mode === "schedule") {
    return scheduleMode(now, prefs.themeScheduleLightAt, prefs.themeScheduleDarkAt);
  }
  return osDark ? "dark" : "light";
}

/** Resolve the stored choice and the system's contrast setting. */
export function resolveAppearance(
  prefs: AppearanceInput,
  caps: AppearanceCapabilities,
  osDark: boolean,
  now: Date = new Date(),
): ResolvedAppearance {
  const intent = migrateAppearanceIntent(prefs);
  const highContrast = intent.highContrast || caps.highContrast || caps.forcedColors;
  const packId: PackId = highContrast ? "highContrast" : intent.packId;
  return {
    packId,
    themeAttr: themeAttrForPack(packId),
    mode: resolveMode(prefs, osDark, now),
    highContrast,
  };
}

export function themeAttrForPack(packId: PackId): string {
  switch (packId) {
    case "hud":
      return "hud";
    case "catppuccin":
      return "catppuccin";
    case "highContrast":
      return "highContrast";
    case "contextos":
      return "contextos";
    default: {
      const _exhaustive: never = packId;
      return _exhaustive;
    }
  }
}

/** Attributes older versions set for window effects. */
const RETIRED_ATTRIBUTES = [
  "requestedMaterial",
  "nativeBackdrop",
  "chromeTreatment",
  "windowMaterial",
  "materialFallback",
  "reduceTransparency",
] as const;

/** Apply resolved axes to the document root (idempotent). */
export function applyAppearanceAttributes(
  root: { dataset: DOMStringMap; style: { colorScheme: string } },
  resolved: ResolvedAppearance,
): void {
  root.dataset.theme = resolved.themeAttr;
  root.dataset.pack = resolved.packId;
  root.dataset.mode = resolved.mode;
  root.dataset.contrast = resolved.highContrast ? "high" : "normal";
  root.style.colorScheme = resolved.mode;
  for (const key of RETIRED_ATTRIBUTES) delete root.dataset[key];
}
