import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/* ============================================================
   Reduced motion has two switches: the OS query and the app's own
   "Reduce motion" setting ([data-reduce-motion="true"]). The
   setting once did less than the query (smooth scrolling survived it) and a
   width transition survived both (security review #5). This walks the real
   stylesheets and sources so neither can drift again.
   ============================================================ */

const ROOT = process.cwd();

function files(dir: string, ext: RegExp, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files(full, ext, found);
    else if (ext.test(entry.name)) found.push(full);
  }
  return found;
}

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const base = strip(fs.readFileSync(path.join(ROOT, "src/styles/base.css"), "utf8"));

/** The body of the OS-query block and the app-setting rules, as text. */
function mediaBlock(css: string): string {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error("unterminated reduced-motion block");
}
function appSettingRules(css: string): string {
  return [...css.matchAll(/([^{}]*\[data-reduce-motion="true"\][^{}]*)\{([^{}]*)\}/g)]
    .map((m) => `${m[1]}{${m[2]}}`)
    .join("\n");
}

describe("reduced motion", () => {
  const query = mediaBlock(base);
  const setting = appSettingRules(base);

  it("both switches turn smooth scrolling off", () => {
    expect(query).toMatch(/scroll-behavior:\s*auto\s*!important/);
    expect(setting).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it("both switches stop every size transition", () => {
    // A rule animating width or height moves the layout; each one must be
    // named in both switches with `transition: none`.
    const sized: string[] = [];
    for (const file of files(path.join(ROOT, "src"), /\.css$/)) {
      const css = strip(fs.readFileSync(file, "utf8"));
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/transition(-property)?\s*:[^;]*\b(width|height)\b/.test(m[2])) {
          sized.push(m[1].trim());
        }
      }
    }
    expect(sized.length).toBeGreaterThan(0);
    for (const selector of sized) {
      const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const stopped = new RegExp(`${esc}[^{]*\\{[^}]*transition:\\s*none`);
      expect(query, `OS query stops ${selector}`).toMatch(stopped);
      expect(setting, `app setting stops ${selector}`).toMatch(
        new RegExp(`\\[data-reduce-motion="true"\\] ${esc}[^{]*\\{[^}]*transition:\\s*none`),
      );
    }
  });

  it("scripts never hard-code a smooth scroll", () => {
    // CSS scroll-behavior does not reach scrollIntoView({ behavior: "smooth" });
    // scripts ask scrollBehavior() in src/lib/motion.ts instead.
    const offenders = files(path.join(ROOT, "src"), /\.tsx?$/)
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => /behavior:\s*["']smooth["']/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
