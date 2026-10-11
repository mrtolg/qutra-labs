import { describe, expect, it } from "vitest";
import { en } from "../en";
import { toolFormsEn } from "./en";
import { toolFormsTr } from "./tr";
import { toolFormsDe } from "./de";
import { toolFormsEs } from "./es";
import { toolFormsFr } from "./fr";
import { toolFormsIt } from "./it";
import { ensureToolFormsLoaded, translateToolForms } from "./index";

/* The tool forms' words live apart from the main catalogs (they load with
   the Tools page), so the catalog tests do not see them. These are the same
   checks: every locale has every key, the placeholders match, and Turkish
   reads like Turkish (turkishCopy.test.ts, the Turkish copy audit §3.4). */

const LOCALES = {
  tr: toolFormsTr,
  de: toolFormsDe,
  es: toolFormsEs,
  fr: toolFormsFr,
  it: toolFormsIt,
} as const;

const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("tool forms copy: key parity", () => {
  for (const [locale, copy] of Object.entries(LOCALES)) {
    it(`${locale} has exactly the English keys, each with the same placeholders`, () => {
      expect(Object.keys(copy).sort()).toEqual(Object.keys(toolFormsEn).sort());
      for (const [key, value] of Object.entries(toolFormsEn)) {
        const translated = (copy as Record<string, string>)[key]!;
        expect(translated.trim(), `${locale} ${key}`).not.toBe("");
        expect(placeholders(translated), `${locale} ${key}`).toEqual(placeholders(value));
      }
    });
  }

  it("never repeats a key the main catalogs already have", () => {
    const shared = Object.keys(toolFormsEn).filter((key) => key in en);
    expect(shared).toEqual([]);
  });
});

// The same rules as turkishCopy.test.ts.
const ENGLISH_WORDS =
  /(?<!\p{L})(the|and|is|are|was|to|of|your|you|this|that|with|for|from|will|be|has|have|or)(?!\p{L})/iu;
const DEVELOPER =
  /(?<!\p{L})(Rust|IPC|PTY|broker|renderer|schema|Tauri|stdout|stderr|loopback|endpoint|native|runtime)(?!\p{L})/iu;

function copyOnly(value: string): string {
  return value
    .replace(/\{\w+\}/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\S*[\\/]\S*/g, " ")
    .replace(/\b[\w.-]+\.(?:rs|ts|exe|json|db|md)\b/g, " ")
    .replace(/`[^`]*`/g, " ");
}

describe("tool forms copy: Turkish", () => {
  const entries = Object.entries(toolFormsTr);

  it("shows no English sentence", () => {
    expect(entries.filter(([, value]) => ENGLISH_WORDS.test(copyOnly(value)))).toEqual([]);
  });

  it("never leaves a multi-word string identical to the English", () => {
    const untranslated = entries
      .filter(([key, value]) => value === (toolFormsEn as Record<string, string>)[key])
      .filter(([, value]) => (copyOnly(value).match(/[A-Za-z]{3,}/g) ?? []).length >= 2);
    expect(untranslated).toEqual([]);
  });

  it("never names how the app is built", () => {
    expect(entries.filter(([, value]) => DEVELOPER.test(copyOnly(value)))).toEqual([]);
  });

  it("keeps the product names", () => {
    expect(
      entries.filter(([, value]) => /çalışma alan/i.test(value) || /\bQutra\b(?! Labs)/.test(value)),
    ).toEqual([]);
  });
});

describe("tool forms copy: lookup", () => {
  it("translates once the locale is loaded and falls back to English, then to the key", async () => {
    expect(translateToolForms("tr", "toolForms.nmap.quick.label")).toBe("Quick scan");
    await ensureToolFormsLoaded("tr");
    expect(translateToolForms("tr", "toolForms.nmap.quick.label")).toBe("Hızlı tarama");
    expect(
      translateToolForms("tr", "toolForms.nmap.quick.summary", { target: "127.0.0.1" }),
    ).toContain("127.0.0.1");
    expect(translateToolForms("tr", "toolForms.nope.label")).toBe("toolForms.nope.label");
  });
});
