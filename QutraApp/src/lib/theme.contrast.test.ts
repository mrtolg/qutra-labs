import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_IDS } from "./theme";
import { oklchContrast } from "./color";

/* Parse the real shipped CSS and assert every theme keeps body text and
   action labels readable. This tests the actual tokens the app renders —
   not a duplicated copy — so the palettes can never silently regress. */

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** Extract `--name: value;` pairs from the first block matching a selector. */
function block(css: string, selector: string): Record<string, string> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const idx = noComments.indexOf(selector);
  if (idx < 0) return {};
  const open = noComments.indexOf("{", idx);
  const close = noComments.indexOf("}", open);
  const body = noComments.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}

const tokens = read("../styles/tokens.css");
const themes = read("../styles/themes.css");

const baseLight = block(tokens, ":root");
const baseDark = block(tokens, '[data-mode="dark"]');

function effective(themeId: string, mode: "light" | "dark"): Record<string, string> {
  const base = mode === "light" ? { ...baseLight } : { ...baseLight, ...baseDark };
  const override = block(themes, `[data-theme="${themeId}"][data-mode="${mode}"]`);
  return { ...base, ...override };
}

const MODES = ["light", "dark"] as const;
// Qutra Labs light uses :root base tokens; dark/HC have theme overrides.
const ALL_THEMES = [...THEME_IDS, "catppuccin", "hud"];

describe("theme contrast (WCAG AA)", () => {
  for (const themeId of ALL_THEMES) {
    for (const mode of MODES) {
      it(`${themeId} / ${mode}: body text ≥ 4.5:1, action label ≥ 4.5:1`, () => {
        const v = effective(themeId, mode);
        const inkBg = oklchContrast(v["--ink"], v["--bg"]);
        expect(inkBg, `--ink on --bg for ${themeId}/${mode}`).not.toBeNull();
        expect(inkBg!).toBeGreaterThanOrEqual(4.5);

        const faintBg = oklchContrast(v["--faint"], v["--bg"]);
        expect(
          faintBg,
          `--faint on --bg for ${themeId}/${mode}`,
        ).not.toBeNull();
        expect(faintBg!).toBeGreaterThanOrEqual(4.5);

        const primaryLabel = oklchContrast(v["--primary-ink"], v["--primary"]);
        expect(primaryLabel, `--primary-ink on --primary for ${themeId}/${mode}`).not.toBeNull();
        expect(primaryLabel!).toBeGreaterThanOrEqual(4.5);

        // Text on a solid danger fill: the critical severity badge and the
        // destructive button.
        const dangerLabel = oklchContrast(v["--danger-ink"], v["--danger"]);
        expect(dangerLabel, `--danger-ink on --danger for ${themeId}/${mode}`).not.toBeNull();
        expect(dangerLabel!).toBeGreaterThanOrEqual(4.5);
        const dangerHover = oklchContrast(v["--danger-ink"], v["--danger-hover"]);
        expect(dangerHover, `--danger-ink on --danger-hover for ${themeId}/${mode}`).not.toBeNull();
        expect(dangerHover!).toBeGreaterThanOrEqual(4.5);
      });

      it(`${themeId} / ${mode}: a field's edge ≥ 3:1 on the grounds (WCAG 1.4.11)`, () => {
        const v = effective(themeId, mode);
        for (const ground of ["--bg", "--surface"]) {
          const edge = oklchContrast(v["--border-control"], v[ground]);
          expect(edge, `--border-control on ${ground} for ${themeId}/${mode}`).not.toBeNull();
          expect(edge!).toBeGreaterThanOrEqual(3);
        }
      });
    }
  }

  it("every rule that fills with --danger sets its text to --danger-ink", () => {
    // Checking token pairs alone missed the rendered pair once: the Lab badge
    // put white on --danger (security review #4). Scan every stylesheet the app ships.
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".css"));
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      const css = readFileSync(join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = m[1].trim();
        const body = m[2];
        if (!/background(-color)?\s*:\s*var\(--danger\)/.test(body)) continue;
        // Text-less marks (dots, timeline pips) carry no label.
        if (/::before|::after|\.dot--/.test(selector)) continue;
        if (!/(^|[;\s])color\s*:\s*var\(--danger-ink\)/.test(body)) {
          offenders.push(`${file}: ${selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("muted text stays legible on the base surfaces", () => {
    // Spot-check Qutra Labs light base for muted-on-surface.
    const light = oklchContrast(baseLight["--muted"], baseLight["--bg"]);
    expect(light!).toBeGreaterThanOrEqual(4.5);
  });
});
