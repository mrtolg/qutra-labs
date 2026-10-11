/* Minimal OKLCH → sRGB conversion + WCAG contrast.
   Used to validate that every theme keeps body text and action labels
   readable (WCAG AA), and to guard the Theme Studio accent picker from
   silently producing inaccessible text. Pure + unit-tested. */

export interface Rgb {
  r: number; // 0..255
  g: number;
  b: number;
}

/** Parse a CSS `oklch(L C H[ / A])` string. L may be 0..1 or a percentage.
 *  Returns null for anything that is not a plain oklch() color. */
export function parseOklch(
  input: string,
): { l: number; c: number; h: number; alpha: number } | null {
  const m = /^oklch\(\s*([^)]+)\)$/i.exec(input.trim());
  if (!m) return null;
  const body = m[1].replace("/", " ");
  const parts = body.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (s: string) =>
    s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s);
  const l = num(parts[0]);
  const c = parseFloat(parts[1]);
  const h = parseFloat(parts[2]);
  const alpha = parts[3] !== undefined ? num(parts[3]) : 1;
  if ([l, c, h, alpha].some((n) => Number.isNaN(n))) return null;
  return { l, c, h, alpha };
}

/** OKLCH → sRGB (gamma-encoded 0..255), clamped to gamut. */
export function oklchToRgb(l: number, c: number, h: number): Rgb {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;

  let r = +4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
  let g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  let bl = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S;

  const enc = (x: number) => {
    const cl = Math.min(1, Math.max(0, x));
    const v = cl <= 0.0031308 ? 12.92 * cl : 1.055 * Math.pow(cl, 1 / 2.4) - 0.055;
    return Math.round(v * 255);
  };
  r = enc(r);
  g = enc(g);
  bl = enc(bl);
  return { r, g, b: bl };
}

/** WCAG relative luminance from gamma-encoded sRGB. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1..21) between two colors. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast between two OKLCH color strings, or null if either is not a
 *  solid oklch color (e.g. it uses alpha, which we treat as unknown). */
export function oklchContrast(fg: string, bg: string): number | null {
  const f = parseOklch(fg);
  const b = parseOklch(bg);
  if (!f || !b || f.alpha < 1 || b.alpha < 1) return null;
  return contrastRatio(oklchToRgb(f.l, f.c, f.h), oklchToRgb(b.l, b.c, b.h));
}
