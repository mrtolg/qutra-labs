import { describe, expect, it } from "vitest";
import { DISALLOWED_TR, DO_NOT_TRANSLATE } from "@/lib/i18n/termbase";
import { builtinEn } from "./en";
import { builtinTr } from "./tr";
import { builtinDe } from "./de";
import { builtinEs } from "./es";
import { builtinFr } from "./fr";
import { builtinIt } from "./it";

/* The built-in tools' catalogs live beside their lazy panels, so the app
   catalog tests (parity, turkishCopy, termbase) do not see them. These
   checks hold them to the same rules. */

const catalogs = { en: builtinEn, tr: builtinTr, de: builtinDe, es: builtinEs, fr: builtinFr, it: builtinIt };
const enKeys = Object.keys(builtinEn).sort();

// As in src/lib/i18n/turkishCopy.test.ts.
const ENGLISH_WORDS =
  /(?<!\p{L})(the|and|is|are|was|to|of|your|you|this|that|with|for|from|will|be|has|have|or)(?!\p{L})/iu;
const DEVELOPER =
  /(?<!\p{L})(Rust|IPC|PTY|broker|renderer|schema|Tauri|stdout|stderr|loopback|endpoint|native|runtime)(?!\p{L})/iu;
const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();

function copyOnly(value: string): string {
  return value
    .replace(/\{\w+\}/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\S*[\\/]\S*/g, " ")
    .replace(/\b[\w.-]+\.(?:rs|ts|exe|json|db|md)\b/g, " ")
    .replace(/`[^`]*`/g, " ");
}

describe("built-in tool catalogs", () => {
  it("have the same keys and placeholders in all six languages", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).sort(), locale).toEqual(enKeys);
      for (const key of enKeys) {
        const value = (catalog as Record<string, string>)[key];
        expect(value.trim(), `${locale} ${key}`).not.toBe("");
        expect(placeholders(value), `${locale} ${key}`).toEqual(placeholders((builtinEn as Record<string, string>)[key]));
      }
    }
  });

  it("read as Turkish in Turkish", () => {
    const english = Object.entries(builtinTr)
      .filter(([, value]) => ENGLISH_WORDS.test(copyOnly(value)))
      .map(([key, value]) => `${key}: ${value}`);
    expect(english).toEqual([]);
    const untranslated = enKeys
      .filter((key) => builtinTr[key as keyof typeof builtinTr] === builtinEn[key as keyof typeof builtinEn])
      .filter((key) => (copyOnly(builtinEn[key as keyof typeof builtinEn]).match(/[A-Za-z]{3,}/g) ?? []).length >= 2)
      .map((key) => `${key}: ${builtinTr[key as keyof typeof builtinTr]}`);
    expect(untranslated).toEqual([]);
  });

  it("never name how the app is built, and keep the product names", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        if (locale === "tr") {
          expect(DEVELOPER.test(copyOnly(value)), `${key}: ${value}`).toBe(false);
          expect(/çalışma alan/i.test(value), key).toBe(false);
          for (const bad of DISALLOWED_TR) expect(value.includes(bad), key).toBe(false);
        }
        expect(/\bQutra\b(?! Labs)/.test(value), `${locale} ${key}`).toBe(false);
      }
    }
  });

  it("keep every brand and standard name in every language", () => {
    for (const key of enKeys) {
      const source = builtinEn[key as keyof typeof builtinEn];
      for (const token of DO_NOT_TRANSLATE) {
        if (!source.includes(token)) continue;
        for (const [locale, catalog] of Object.entries(catalogs)) {
          expect((catalog as Record<string, string>)[key], `${locale} ${key} keeps ${token}`).toContain(token);
        }
      }
    }
  });
});
