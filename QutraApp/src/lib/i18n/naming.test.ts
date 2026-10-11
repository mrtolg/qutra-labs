import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { en as enBase } from "./en";
import { tr as trBase } from "./tr";
import { de as deBase } from "./de";
import { es as esBase } from "./es";
import { fr as frBase } from "./fr";
import { it as itBase } from "./it";
import { DO_NOT_TRANSLATE } from "./termbase";
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

/* ============================================================
   Product name vs. internal identifier.

   These are deliberately different and must stay that way:

     "Qutra Labs"  — the product name the user sees. Titlebar, window title,
                     installer, `app.name` in every locale.
     "contextos"   — the internal identifier. npm package, Tauri bundle id,
                     `contextos.db`, the `contextos.v1.*` storage keys, the
                     `contextos_fixture.rs` reference adapter, the repo.

   A blanket find/replace in either direction is the specific failure this
   guards. One has already happened: a rename swept the *literal filename* in
   the Lab hint and produced `src-tauri/fixtures/Qutra Labs_fixture.rs`, a path
   that does not exist, in all six locales. Key-parity tests could not see it
   because the key was present and translated.
   ============================================================ */

const ROOT = process.cwd();
const catalogs = { en, tr, de, es, fr, it: itCatalog } as const;

const read = (rel: string) =>
  fs.readFileSync(path.resolve(ROOT, rel), "utf8");

describe("product name is Qutra Labs", () => {
  it("is the display name in every locale", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(catalog["app.name"], `${locale} app.name`).toBe("Qutra Labs");
    }
  });

  it("is protected from translation", () => {
    expect(DO_NOT_TRANSLATE).toContain("Qutra Labs");
  });

  it("is the window and installer name", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(conf.productName).toBe("Qutra Labs");
    expect(conf.app.windows[0].title).toBe("Qutra Labs");
    expect(read("index.html")).toContain("<title>Qutra Labs</title>");
  });
});

describe("internal identifiers stay contextos", () => {
  it("keeps the package, bundle id and database name", () => {
    expect(JSON.parse(read("package.json")).name).toBe("contextos");

    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    // Renaming this moves the Tauri app-data directory, which would orphan the
    // existing database, tool registry and Private Lab consent marker.
    expect(conf.identifier).toBe("app.contextos.desktop");
    expect(JSON.stringify(conf)).toContain("sqlite:contextos.db");
  });

  it("keeps the storage key prefix", () => {
    // Changing this silently abandons every existing user's preferences.
    expect(read("src/lib/db/storage.ts") + read("src/lib/db/database.ts")).toContain(
      "contextos.v1.",
    );
  });
});

describe("the two names never bleed into each other", () => {
  it("no translated string embeds the product name in a file path or identifier", () => {
    const offenders: string[] = [];

    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        // A path, filename or dotted identifier containing "Qutra" means a
        // rename swept something that was never prose.
        if (/[\w/\\.-]*Qutra[\w ]*(\.(rs|ts|db|json|exe)|\/|\\)/.test(value)) {
          offenders.push(`${locale}.${key}: ${value}`);
        }
      }
    }

    expect(
      offenders,
      `the product name leaked into a path or identifier:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no catalog string names a machine-specific lab start script", () => {
    const offenders: string[] = [];
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        if (/Local-AI-Lab|start-isolated-ollama/i.test(value)) {
          offenders.push(`${locale}.${key}: ${value}`);
        }
      }
    }
    expect(
      offenders,
      `user-facing copy named a machine-specific path:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no user-facing catalog string exposes the internal identifier as a brand", () => {
    // "contextos" may appear as a literal path/filename (contextos_fixture.rs,
    // contextos.db) but must never stand in for the product name.
    const offenders: string[] = [];
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        // "contextos" standing alone is a brand use; the same word inside a
        // literal path/filename/identifier (contextos_fixture.rs, contextos.db,
        // contextos.v1.) is allowed, so exclude a following word char, dot,
        // slash or hyphen.
        if (/\bcontextos\b(?![\w./\\-])/i.test(value))
          offenders.push(`${locale}.${key}: ${value}`);
      }
    }
    expect(
      offenders,
      `these strings show the internal name to users:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
