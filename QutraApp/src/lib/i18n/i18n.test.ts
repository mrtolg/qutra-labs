import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { en } from "./en";
import { tr } from "./tr";
import { de } from "./de";
import { es } from "./es";
import { fr } from "./fr";
import { it as itCatalog } from "./it";
import { ensureLocaleLoaded, translate } from "./index";
import { LOCALE_NAMES, SUPPORTED_LOCALES, resolveLocale } from "./locales";
// The built-in tools' words load with their lazy panels (their own catalog
// test holds them to the same rules).
import { builtinEn } from "@/features/tools/builtin/i18n/en";
// The words only lazy pages read load after the first paint (./deferred).
import { deferredEn } from "./deferred/en";
import { deferredTr } from "./deferred/tr";
import { deferredDe } from "./deferred/de";
import { deferredEs } from "./deferred/es";
import { deferredFr } from "./deferred/fr";
import { deferredIt } from "./deferred/it";

const catalogs = { tr, de, es, fr, it: itCatalog } as const;
const enKeys = Object.keys(en).sort();
const deferredCopies = {
  tr: deferredTr,
  de: deferredDe,
  es: deferredEs,
  fr: deferredFr,
  it: deferredIt,
} as const;
const deferredKeys = Object.keys(deferredEn).sort();

beforeAll(async () => {
  await Promise.all(SUPPORTED_LOCALES.map((locale) => ensureLocaleLoaded(locale)));
});

/** Extract {placeholder} tokens from a string. */
function params(s: string): string[] {
  return (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
}

describe("locale key parity", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} has exactly the same keys as en`, () => {
      const keys = Object.keys(catalog).sort();
      const missing = enKeys.filter((k) => !(k in catalog));
      const extra = keys.filter((k) => !(k in en));
      expect(missing, `${locale} missing keys`).toEqual([]);
      expect(extra, `${locale} extra keys`).toEqual([]);
    });

    it(`${locale} preserves every interpolation placeholder`, () => {
      const mismatches: string[] = [];
      for (const key of enKeys) {
        const enParams = params(en[key as keyof typeof en]);
        const locParams = params(
          (catalog as Record<string, string>)[key] ?? "",
        );
        if (JSON.stringify(enParams) !== JSON.stringify(locParams)) {
          mismatches.push(`${key}: en[${enParams}] vs ${locale}[${locParams}]`);
        }
      }
      expect(mismatches, `${locale} placeholder mismatches`).toEqual([]);
    });
  }
});

/* A sentence left in English in German, Spanish, French or Italian is a gap a
   parity test cannot see: the key is there and the words are not. These
   values are the same as English on purpose (a name, a unit, a word the
   language shares). */
const SAME_ON_PURPOSE = new Set([
  "app.name",
  "theme.contextos",
  "tools.enableTitle",
  "tools.item.juiceshop.name",
  "work.pid",
  "lab.wb.elapsed",
  "today.minutes",
  "today.sessionsCount",
  "lab.tools.argDefaultName",
  "lab.newFinding.description",
  "lab.switch.button",
  "lab.analysis.step.hashes",
  "lab.files.bytes",
  "lab.report.md.title",
  "settings.cloud.anthropicName",
  "settings.cloud.braveName",
  "jarvis.cloud.cost",
  "jarvis.header.localAt",
  "jarvis.history.folderCount",
  "assistant.greet.withName",
]);

describe("no sentence is left in English", () => {
  const untranslated = (copy: Record<string, string>, english: Record<string, string>) =>
    Object.keys(english).filter(
      (key) =>
        copy[key] === english[key] &&
        english[key]!.trim().split(/\s+/).length > 1 &&
        !SAME_ON_PURPOSE.has(key),
    );

  for (const locale of ["de", "es", "fr", "it"] as const) {
    it(`${locale} answers every multi-word English value in its own words`, () => {
      expect(untranslated(catalogs[locale], en), `${locale} catalog`).toEqual([]);
      expect(
        untranslated(deferredCopies[locale], deferredEn),
        `${locale} deferred catalog`,
      ).toEqual([]);
    });
  }
});

describe("deferred words: key parity", () => {
  for (const [locale, copy] of Object.entries(deferredCopies)) {
    it(`${locale} has exactly the deferred English keys, with the same placeholders`, () => {
      expect(Object.keys(copy).sort()).toEqual(deferredKeys);
      const mismatches = deferredKeys.filter(
        (key) =>
          JSON.stringify(params(deferredEn[key as keyof typeof deferredEn])) !==
          JSON.stringify(params((copy as Record<string, string>)[key] ?? "")),
      );
      expect(mismatches, `${locale} placeholder mismatches`).toEqual([]);
    });
  }

  it("never repeats a catalog key", () => {
    expect(deferredKeys.filter((key) => key in en)).toEqual([]);
  });
});

/* The deferred words load after the first paint, so no module a first paint
   loads may read one: it would show English, or the key, for a moment. The
   first paint is every module src/main.tsx reaches through static imports
   (not import(), not type-only imports); each quoted key in them, or each
   template such as `settings.${section}`, must not name a deferred key. */
describe("first paint reads no deferred word", () => {
  it("finds no deferred key in a first-paint module", () => {
    const sourceRoot = path.resolve(process.cwd(), "src");
    const importPattern =
      /^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith("@/")
        ? path.join(sourceRoot, spec.slice(2))
        : spec.startsWith(".")
          ? path.resolve(path.dirname(from), spec)
          : null;
      if (!base) return null;
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
      return null;
    };
    const typeOnly = (clause: string) => {
      const names = /^\{([^}]*)\}$/.exec(clause.trim())?.[1]?.split(",").map((n) => n.trim()).filter(Boolean);
      return Boolean(names?.length) && names!.every((name) => name.startsWith("type "));
    };
    const firstPaint = new Set<string>();
    const stack = [path.join(sourceRoot, "main.tsx")];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (firstPaint.has(file)) continue;
      firstPaint.add(file);
      for (const m of fs.readFileSync(file, "utf8").matchAll(importPattern)) {
        if (m[1] || (m[2] && typeOnly(m[2]))) continue;
        const target = resolve(file, m[3] ?? m[4] ?? "");
        if (target && /\.(ts|tsx)$/.test(target)) stack.push(target);
      }
    }
    const groups = [...new Set(deferredKeys.map((key) => key.split(".")[0]))];
    const quoted = new RegExp(`["'\`]((?:${groups.join("|")})\\.[^"'\`\\s]*)["'\`]`, "g");
    const hits: string[] = [];
    for (const file of firstPaint) {
      if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
      for (const [, literal] of fs.readFileSync(file, "utf8").matchAll(quoted)) {
        const pattern = new RegExp(
          `^${literal!.replace(/[.*+?^()|[\]\\]/g, "\\$&").replace(/\$\{[^}]*\}/g, "[^.]+")}$`,
        );
        for (const key of deferredKeys) {
          if (pattern.test(key)) hits.push(`${key} (${path.relative(sourceRoot, file)})`);
        }
      }
    }
    expect(firstPaint.size).toBeGreaterThan(50);
    expect(hits).toEqual([]);
  }, 30_000);
});

describe("source-to-catalog gate", () => {
  it("keeps every literal translation call backed by the English catalog", () => {
    const sourceRoot = path.resolve(process.cwd(), "src");
    const files: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
          files.push(target);
        }
      }
    };
    visit(sourceRoot);

    const missing = new Set<string>();
    const callPattern = /\bt\(\s*["']([^"']+)["']/g;
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(callPattern)) {
        if (!(match[1] in en) && !(match[1] in builtinEn) && !(match[1] in deferredEn)) {
          missing.add(`${match[1]} (${path.relative(sourceRoot, file)})`);
        }
      }
    }
    expect([...missing].sort()).toEqual([]);
    // It reads every source file: under the full parallel run on a loaded
    // machine that took 6 s, past the 5 s default, with nothing missing.
  }, 30_000);

  it("does not retain retired product vocabulary as catalog keys", () => {
    const retired = [
      /^inbox\./,
      /^notes\./,
      /^pages\./,
      /^clip\./,
      /^timeline\./,
      /^snippets\./,
      /^errors\./,
      /^perm\.clipboard_history/,
      /^lab\.view\.academy$/,
    ];
    const found = enKeys.filter((key) => retired.some((pattern) => pattern.test(key)));
    expect(found).toEqual([]);
  });
});

describe("translate", () => {
  it("interpolates params across locales", () => {
    expect(translate("de", "common.results", { count: 5 })).toBe("5 Ergebnisse");
    expect(translate("fr", "common.results", { count: 5 })).toBe("5 résultats");
    expect(translate("it", "onb.step", { current: 2, total: 4 })).toBe(
      "Passo 2 di 4",
    );
  });

  it("falls back to English for an unexpected missing key", () => {
    // @ts-expect-error deliberately unknown key
    expect(translate("de", "nonexistent.key")).toBe("nonexistent.key");
    // A key present in en is always resolvable even if a catalog lacked it.
    expect(translate("es", "app.name")).toBe("Qutra Labs");
  });
});

describe("locale registry", () => {
  it("has a native display name for every supported locale", () => {
    for (const l of SUPPORTED_LOCALES) {
      expect(LOCALE_NAMES[l]).toBeTruthy();
    }
    expect(LOCALE_NAMES.tr).toBe("Türkçe");
    expect(LOCALE_NAMES.de).toBe("Deutsch");
  });

  it("resolves OS language tags to a supported locale, else English", () => {
    expect(resolveLocale("de-DE")).toBe("de");
    expect(resolveLocale("fr")).toBe("fr");
    expect(resolveLocale("pt-BR")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });

  it("stores Turkish dotted/dotless I and accents without mojibake", () => {
    expect(tr["nav.projects"]).toBe("Projeler");
    expect(deferredTr["settings.about.author"]).toContain("tasarlandı");
    expect(deferredDe["settings.about.author"]).toContain("entwickelt");
    // round-trips through JSON as clean UTF-8
    expect(JSON.parse(JSON.stringify(tr))["nav.projects"]).toBe("Projeler");
  });
});

/* The fixture hint names a file the user is told to compile. A brand-wide
   find/replace once rewrote the literal filename to "Qutra Labs_fixture.rs",
   which pointed every locale at a path that does not exist — a string the key
   parity test above cannot catch, because the key was present and translated.
   So this asserts the referenced path against the real file on disk. */
describe("lab fixture hint points at a real file", () => {
  const allCatalogs = { en, ...catalogs } as const;

  for (const [locale, catalog] of Object.entries(allCatalogs)) {
    it(`${locale} references a fixture that exists in the repo`, () => {
      const hint = catalog["lab.tools.fixtureHint"];
      const match = hint.match(/src-tauri\/fixtures\/[\w.-]+\.rs/);

      expect(match, `${locale} hint must name a src-tauri/fixtures/*.rs path`).not.toBeNull();

      const relative = match![0];
      const absolute = path.resolve(process.cwd(), relative);
      expect(
        fs.existsSync(absolute),
        `${locale} points at ${relative}, which does not exist on disk`,
      ).toBe(true);
    });
  }
});
