import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { GITHUB_LANGUAGE_COLORS, languageColor } from "./languageColors";

/* GitHub's language colours are the one approved data-colour exception
   to "tokens only" (DESIGN.md → Colour). They live in one constant; no
   component hard-codes a hex. */

const ROOT = process.cwd();

function tsxFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, found);
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) found.push(full);
  }
  return found;
}

describe("GitHub language colours", () => {
  it("come from the one constant, with a token for anything unknown", () => {
    expect(languageColor("Rust")).toBe(GITHUB_LANGUAGE_COLORS.Rust);
    expect(languageColor("COBOL")).toBe("var(--faint)");
  });

  it("are the only hex colours, and no component hard-codes one", () => {
    const offenders = tsxFiles(path.join(ROOT, "src"))
      .filter((f) => /["'`]#[0-9a-fA-F]{3,8}\b/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("turn to ink in high contrast, beside the language name", () => {
    const css = fs.readFileSync(path.join(ROOT, "src/features/github/github.css"), "utf8");
    expect(css).toMatch(
      /\[data-theme="highContrast"\] \.github-language-dot\s*\{[^}]*background:\s*var\(--ink\)\s*!important/,
    );
    const page = fs.readFileSync(path.join(ROOT, "src/features/github/GitHubPage.tsx"), "utf8");
    // The dot never stands alone: it sits in the same span as the name.
    expect(page).toMatch(/<span className="github-language-dot"[^>]*\/>\s*\{r\.language\}/);
  });
});
