import { oklchToRgb, parseOklch } from "./color";

export interface XtermThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

const TOKEN_NAMES = [
  "--terminal-bg",
  "--surface-sunken",
  "--ink",
  "--primary",
  "--selection-bg",
] as const;

/** Convert an `oklch()` token to `#rrggbb` or `#rrggbbaa` when alpha < 1. */
export function oklchTokenToHex(value: string): string | null {
  const parsed = parseOklch(value.trim());
  if (!parsed) return null;
  const { r, g, b } = oklchToRgb(parsed.l, parsed.c, parsed.h);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const rgb = `#${hex(r)}${hex(g)}${hex(b)}`;
  if (parsed.alpha >= 1) return rgb;
  return `${rgb}${hex(Math.round(parsed.alpha * 255))}`;
}

export function themeFromCssValues(
  tokens: Partial<Record<(typeof TOKEN_NAMES)[number], string>>,
): XtermThemeColors | null {
  const background = oklchTokenToHex(
    tokens["--terminal-bg"] || tokens["--surface-sunken"] || "",
  );
  const foreground = oklchTokenToHex(tokens["--ink"] || "");
  const cursor = oklchTokenToHex(tokens["--primary"] || "");
  const selectionBackground = oklchTokenToHex(tokens["--selection-bg"] || "");
  if (!background || !foreground || !cursor || !selectionBackground) return null;
  return { background, foreground, cursor, selectionBackground };
}

export function readCssColorTokens(
  root: Element,
): Partial<Record<(typeof TOKEN_NAMES)[number], string>> {
  if (typeof getComputedStyle !== "function") return {};
  const cs = getComputedStyle(root);
  const out: Partial<Record<(typeof TOKEN_NAMES)[number], string>> = {};
  for (const name of TOKEN_NAMES) {
    const value = cs.getPropertyValue(name).trim();
    if (value) out[name] = value;
  }
  return out;
}

export function xtermThemeFromDocument(root: Element = document.documentElement): XtermThemeColors | null {
  return themeFromCssValues(readCssColorTokens(root));
}
