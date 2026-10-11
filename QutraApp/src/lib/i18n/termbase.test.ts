import { describe, expect, it } from "vitest";
import { en as enBase } from "./en";
import { tr as trBase } from "./tr";
import { de as deBase } from "./de";
import { es as esBase } from "./es";
import { fr as frBase } from "./fr";
import { it as itBase } from "./it";
import {
  DISALLOWED_TR,
  DO_NOT_TRANSLATE,
  TERMBASE,
  TERMBASE_VERSION,
} from "./termbase";
import { deferredEn } from "./deferred/en";
import { deferredTr } from "./deferred/tr";
import { deferredDe } from "./deferred/de";
import { deferredEs } from "./deferred/es";
import { deferredFr } from "./deferred/fr";
import { deferredIt } from "./deferred/it";

// The words only lazy pages read (./deferred) are held to the same rules.
const en = { ...enBase, ...deferredEn };
const tr = { ...trBase, ...deferredTr };
const de = { ...deBase, ...deferredDe };
const es = { ...esBase, ...deferredEs };
const fr = { ...frBase, ...deferredFr };
const itCatalog = { ...itBase, ...deferredIt };

const allCatalogs = { en, tr, de, es, fr, it: itCatalog } as const;

describe("termbase", () => {
  it("declares a version", () => {
    expect(TERMBASE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("binds every approved Turkish term to its catalog key(s)", () => {
    const mismatches: string[] = [];
    for (const entry of TERMBASE) {
      const approved = entry.approved.tr;
      if (!approved || !entry.keys) continue;
      for (const key of entry.keys) {
        const actual = tr[key];
        if (actual !== approved) {
          mismatches.push(`${key}: "${actual}" ≠ approved "${approved}"`);
        }
      }
    }
    expect(mismatches, "Turkish terminology drift").toEqual([]);
  });

  it("never reintroduces a disallowed literal translation", () => {
    const hits: string[] = [];
    for (const [key, value] of Object.entries(tr)) {
      for (const bad of DISALLOWED_TR) {
        if (value.includes(bad)) hits.push(`${key} contains "${bad}"`);
      }
    }
    expect(hits, "disallowed Turkish terms present").toEqual([]);
  });

  it("preserves do-not-translate brand terms across every locale", () => {
    const violations: string[] = [];
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const enValue = en[key];
      for (const token of DO_NOT_TRANSLATE) {
        if (!enValue.includes(token)) continue;
        for (const [locale, catalog] of Object.entries(allCatalogs)) {
          const value = (catalog as Record<string, string>)[key] ?? "";
          if (!value.includes(token)) {
            violations.push(`${locale}[${key}] dropped brand "${token}"`);
          }
        }
      }
    }
    expect(violations, "brand term not preserved").toEqual([]);
  });

  it("names an investigation in every locale, never the old engagement nouns", () => {
    // Spec 2026-10-07 D2: the engagement is an investigation (tr "inceleme").
    const old: Record<string, RegExp> = {
      en: /\bengagements?\b/i,
      // "çalışmaya devam" ("keeps working") is a verb, not the old noun.
      tr: /güvenlik çalışma|bu çalışma(nın|yı|da)\b|çalışmanın (adı|kapsamı|klasörü)|çalışmayla birlikte|çalışmaya bir ad|^çalışmalar \(|” çalışmas(ı|ını|ındaki)\b/i,
      de: /\bEngagements?\b/,
      es: /\bcompromisos?\b/i,
      fr: /\bengagements?\b/i,
      it: /\bingaggi(o)?\b|\bengagement\b/i,
    };
    const hits: string[] = [];
    for (const [locale, catalog] of Object.entries(allCatalogs)) {
      for (const [key, value] of Object.entries(catalog as Record<string, string>)) {
        if (old[locale]!.test(value)) hits.push(`${locale}[${key}]: ${value}`);
      }
    }
    expect(hits, "old engagement noun still shown").toEqual([]);
  });

  it("never shows a raw message key as a value", () => {
    // A value equal to its own key means a missing translation slipped through.
    const raw: string[] = [];
    for (const [locale, catalog] of Object.entries(allCatalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        if (value === key) raw.push(`${locale}[${key}]`);
      }
    }
    expect(raw, "raw keys shown as text").toEqual([]);
  });
});
