import { describe, expect, it } from "vitest";
import { deferredDe } from "@/lib/i18n/deferred/de";
import { deferredEn } from "@/lib/i18n/deferred/en";
import { deferredEs } from "@/lib/i18n/deferred/es";
import { deferredFr } from "@/lib/i18n/deferred/fr";
import { deferredIt } from "@/lib/i18n/deferred/it";
import { deferredTr } from "@/lib/i18n/deferred/tr";
import { en } from "@/lib/i18n/en";
import { GUIDES, HIDE_KEY_NAME, PAGE_NAME, guideFor, hideKeyFor, pageIdFor, type PageId } from "./guides";

const at = (path: string) => {
  const [pathname = "", search = ""] = path.split("?");
  return pageIdFor({ pathname, search: search ? `?${search}` : "" });
};

describe("the page a route is", () => {
  it("names a page for every route of the app", () => {
    expect(at("/overview")).toBe("overview");
    expect(at("/workspaces")).toBe("projects");
    expect(at("/workspaces/abc/notes")).toBe("projects");
    expect(at("/sessions/focus")).toBe("projects");
    expect(at("/files")).toBe("files");
    expect(at("/github")).toBe("github");
    expect(at("/terminal")).toBe("terminal");
    expect(at("/jarvis")).toBe("assistant");
    expect(at("/nowhere")).toBe("generic");
  });

  it("follows the investigation section and the tools section in the query", () => {
    expect(at("/lab")).toBe("lab.overview");
    expect(at("/lab?e=x&view=targets")).toBe("lab.targets");
    expect(at("/lab?e=x&view=runs")).toBe("lab.runs");
    expect(at("/lab?view=evidence")).toBe("lab.evidence");
    expect(at("/lab?view=findings")).toBe("lab.findings");
    expect(at("/lab?view=report")).toBe("lab.report");
    expect(at("/lab?view=scope")).toBe("lab.scope");
    expect(at("/lab?list=1")).toBe("lab.list");
    expect(at("/lab?view=bogus")).toBe("lab.overview");
    expect(at("/tools")).toBe("tools.box");
    expect(at("/tools?view=registered")).toBe("tools.registered");
    expect(at("/tools?view=catalog")).toBe("tools.catalog");
    expect(at("/tools?view=playbooks")).toBe("tools.playbooks");
    expect(at("/tools?view=datasets")).toBe("tools.datasets");
  });

  it("is Settings whenever a Settings section is open", () => {
    expect(pageIdFor({ pathname: "/lab", search: "?view=runs", settingsSection: "privacy" })).toBe(
      "settings",
    );
  });
});

describe("the guide of every page", () => {
  const pages = Object.keys(PAGE_NAME) as PageId[];

  it("has a few steps for every page but the assistant's own", () => {
    for (const page of pages) {
      const steps = guideFor(page);
      if (page === "assistant") expect(steps).toEqual([]);
      else {
        expect(steps.length, page).toBeGreaterThanOrEqual(2);
        expect(steps.length, page).toBeLessThanOrEqual(4);
      }
    }
    expect(Object.keys(GUIDES).sort()).toEqual(pages.filter((p) => p !== "assistant").sort());
  });

  it("writes every step in all six languages, and every page name exists", () => {
    const copies = {
      en: deferredEn,
      tr: deferredTr,
      de: deferredDe,
      es: deferredEs,
      fr: deferredFr,
      it: deferredIt,
    } as Record<string, Record<string, string>>;
    for (const page of pages) {
      for (const step of guideFor(page)) {
        for (const [locale, copy] of Object.entries(copies)) {
          expect(copy[step.text], `${locale} ${step.text}`).toBeTruthy();
        }
      }
      const name = PAGE_NAME[page];
      expect(name in en || name in deferredEn, name).toBe(true);
    }
  });

  it("points only at names the app can carry (lowercase tokens)", () => {
    for (const page of pages) {
      for (const step of guideFor(page)) {
        if (step.target) expect(step.target).toMatch(/^[a-z0-9-]{1,40}$/);
      }
    }
  });

  it("gives the Qutra page no steps, and hides a whole area under one key", () => {
    expect(guideFor("assistant")).toEqual([]);
    expect(hideKeyFor("lab.runs")).toBe("lab");
    expect(hideKeyFor("tools.box")).toBe("tools");
    expect(hideKeyFor("overview")).toBe("overview");
    for (const page of pages.filter((p) => p !== "assistant")) {
      expect(HIDE_KEY_NAME[hideKeyFor(page)], page).toBeDefined();
    }
  });
});
