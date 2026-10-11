import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/* ============================================================
   Design-token lint.

   A `var(--never-defined)` does not throw, warn, or show up anywhere: CSS
   simply drops the declaration. That is how `github.css` shipped a search field
   whose focus ring referenced `--focus` (the real token is `--focus-ring`) —
   the outline silently did not exist, quietly contradicting the WCAG
   visible-focus claim in PRODUCT.md, and no test or type-check could see it.

   So every custom property a stylesheet consumes must be defined by a
   stylesheet, and this walks the real files to prove it.
   ============================================================ */

const ROOT = process.cwd();

function cssFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) cssFiles(full, found);
    else if (entry.name.endsWith(".css")) found.push(full);
  }
  return found;
}

const files = cssFiles(path.join(ROOT, "src"));
const sources = files.map((file) => ({
  file: path.relative(ROOT, file).replace(/\\/g, "/"),
  text: fs.readFileSync(file, "utf8"),
}));

/** Every `--token:` declaration across the stylesheets. */
const defined = new Set<string>();
for (const { text } of sources) {
  for (const [, name] of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(name);
}

/** Components may also define a token inline (`style={{ "--x": … }}`). */
function collectInlineDefinitions(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectInlineDefinitions(full);
    else if (/\.tsx?$/.test(entry.name)) {
      const text = fs.readFileSync(full, "utf8");
      for (const [, name] of text.matchAll(/["'](--[\w-]+)["']\s*:/g)) {
        defined.add(name);
      }
    }
  }
}
collectInlineDefinitions(path.join(ROOT, "src"));

describe("design tokens", () => {
  it("defines every custom property the stylesheets consume", () => {
    const missing: string[] = [];

    for (const { file, text } of sources) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        // `var(--x, fallback)` is a deliberate default, so only the
        // no-fallback form is required to resolve.
        for (const [, name] of line.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
          if (!defined.has(name)) missing.push(`${file}:${i + 1} → var(${name})`);
        }
      });
    }

    expect(
      missing,
      `these custom properties are used but never defined, so the declaration is silently dropped:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the focus ring token real, since visible focus is a stated commitment", () => {
    expect(defined.has("--focus-ring")).toBe(true);
    // The name that was wrongly used must not quietly come into existence as a
    // second, competing focus token.
    expect(defined.has("--focus")).toBe(false);
  });
});
