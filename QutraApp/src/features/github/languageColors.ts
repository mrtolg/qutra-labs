/* GitHub's own language colours: the one approved data-colour exception to
   "tokens only" (DESIGN.md → Colour). The dot always sits beside the
   language name, so colour never carries the meaning alone, and it turns to
   --ink in high contrast (github.css). Add languages here, nowhere else. */

export const GITHUB_LANGUAGE_COLORS: Readonly<Record<string, string>> = Object.freeze({
  TypeScript: "#3178c6",
  JavaScript: "#d4b830",
  Rust: "#d7683f",
  Python: "#3572a5",
  Java: "#b07219",
  Go: "#00add8",
  Shell: "#5b9867",
  HTML: "#e34c26",
  CSS: "#663399",
});

export function languageColor(language: string): string {
  return GITHUB_LANGUAGE_COLORS[language] ?? "var(--faint)";
}
