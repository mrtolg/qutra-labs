import { describe, expect, it } from "vitest";
import { en as enBase } from "./en";
import { tr as trBase } from "./tr";
import { deferredEn } from "./deferred/en";
import { deferredTr } from "./deferred/tr";

// The words only lazy pages read (./deferred) are held to the same rules.
const en = { ...enBase, ...deferredEn };
const tr = { ...trBase, ...deferredTr };

/*
 * Turkish reads like Turkish. These checks run on
 * the catalog, so they cover every string the Turkish UI can show, including
 * states an e2e walk never reaches. Rules: the Turkish copy audit §3.4
 * (docs/i18n/turkish-copy-audit.md).
 */

// Words that only occur in English sentences. Turkish words are left out on
// purpose: "not" (a note), "can" (life), "an" (a moment), "on" (ten).
// Letters, not \b, bound a word, so "İşlem" never matches "is".
const ENGLISH_WORDS =
  /(?<!\p{L})(the|and|is|are|was|to|of|your|you|this|that|with|for|from|will|be|has|have|or)(?!\p{L})/iu;

// Values a Turkish UI may show exactly as English: names and technical tokens
// with no Turkish form (termbase DO_NOT_TRANSLATE, product and tool names).
const SAME_AS_ENGLISH_ALLOWED = new Set<string>([
  "app.name", // Qutra Labs
  "theme.contextos", // Qutra Labs
  "tools.enableTitle", // Private Lab stays English
  "tools.item.juiceshop.name", // OWASP Juice Shop, a product name
  "settings.cloud.anthropicName", // Claude (Anthropic), a product and company name
]);

// A placeholder, a URL, a path or a command line is data, not copy.
function copyOnly(value: string): string {
  return value
    .replace(/\{\w+\}/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\S*[\\/]\S*/g, " ")
    .replace(/\b[\w.-]+\.(?:rs|ts|exe|json|db|md)\b/g, " ")
    .replace(/`[^`]*`/g, " ");
}

describe("Turkish catalog", () => {
  it("shows no English sentence", () => {
    const english = Object.entries(tr)
      .filter(([, value]) => ENGLISH_WORDS.test(copyOnly(value)))
      .map(([key, value]) => `${key}: ${value}`);
    expect(english).toEqual([]);
  });

  it("never leaves a multi-word string identical to the English", () => {
    const untranslated = (Object.keys(en) as (keyof typeof en)[])
      .filter((key) => tr[key] === en[key])
      .filter((key) => (copyOnly(en[key]).match(/[A-Za-z]{3,}/g) ?? []).length >= 2)
      .filter((key) => !SAME_AS_ENGLISH_ALLOWED.has(key))
      .map((key) => `${key}: ${tr[key]}`);
    expect(untranslated).toEqual([]);
  });

  it("never names how the app is built", () => {
    const developer =
      /(?<!\p{L})(Rust|IPC|PTY|broker|renderer|schema|Tauri|stdout|stderr|loopback|endpoint|native|runtime)(?!\p{L})/iu;
    const hits = Object.entries(tr)
      .filter(([, value]) => developer.test(copyOnly(value)))
      .map(([key, value]) => `${key}: ${value}`);
    expect(hits).toEqual([]);
  });

  it("keeps the product names: proje, Qutra (never Jarvis)", () => {
    const hits = Object.entries(tr)
      .filter(([, value]) => /çalışma alan/i.test(value) || /Jarvis/i.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(hits).toEqual([]);
  });
});
