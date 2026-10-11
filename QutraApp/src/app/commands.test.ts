import { describe, expect, it } from "vitest";
import type { RouteObject } from "react-router-dom";
import { en } from "@/lib/i18n/en";
import { LAB_VIEWS, TOOLS_VIEWS } from "@/domain/workbench";
import { SETTINGS_SECTIONS } from "@/features/settings/sections";
import { router } from "./router";
import { PALETTE_GROUPS, PALETTE_TARGETS } from "./commands";

/* Routes the palette deliberately does not list, each with the place that
   reaches it instead. Adding a route means adding a palette target or a row
   here with its reason — never silently neither. */
const NOT_IN_PALETTE: Record<string, string> = {
  "/onboarding": "first run only; RequireOnboarding sends the user there",
  "/workspaces/:id": "each project is its own palette entry",
  "/workspaces/:id/:tab": "project tabs, reached from the project page",
  "/sessions/focus": "needs a running session; New session leads there",
  "/*": "not-found fallback",
};

function staticPaths(routes: RouteObject[], base = ""): string[] {
  return routes.flatMap((route) => {
    if (route.index) return [];
    const path =
      route.path === "/"
        ? ""
        : `${base}/${route.path ?? ""}`.replace(/\/+/g, "/");
    const own = route.path && route.path !== "/" ? [path] : [];
    return [...own, ...staticPaths(route.children ?? [], path)];
  });
}

describe("command registry", () => {
  const destinations = new Set(
    PALETTE_TARGETS.flatMap((t) => (t.to ? [t.to] : [])),
  );

  it("reaches every route of the router", () => {
    const missing = staticPaths(router.routes).filter(
      (path) => !destinations.has(path) && !(path in NOT_IN_PALETTE),
    );
    expect(missing).toEqual([]);
  });

  it("lists no exception for a route that no longer exists", () => {
    const paths = new Set(staticPaths(router.routes));
    expect(Object.keys(NOT_IN_PALETTE).filter((p) => !paths.has(p))).toEqual(
      [],
    );
  });

  it("reaches every Lab view", () => {
    for (const view of LAB_VIEWS) {
      expect(destinations).toContain(`/lab?view=${view}`);
    }
  });

  it("reaches every Tools section, the guides among them", () => {
    for (const view of TOOLS_VIEWS) {
      expect(destinations).toContain(`/tools?view=${view}`);
    }
  });

  it("reaches every Settings section, in the modal rather than by route", () => {
    const sections = PALETTE_TARGETS.flatMap((t) =>
      t.settings ? [t.settings] : [],
    );
    expect(sections).toEqual([...SETTINGS_SECTIONS]);
    expect([...destinations].filter((to) => to.startsWith("/settings"))).toEqual(
      [],
    );
  });

  it("opens Settings itself as an action", () => {
    expect(PALETTE_TARGETS.map((t) => t.action)).toContain("open-settings");
  });

  it("gives every target a unique id, a real label and a known group", () => {
    const ids = PALETTE_TARGETS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = new Set(PALETTE_GROUPS.map(([g]) => g));
    for (const target of PALETTE_TARGETS) {
      expect(en).toHaveProperty([target.labelKey]);
      expect(groups).toContain(target.group);
      // Exactly one of: a destination, an action or a Settings section.
      expect(
        [target.to, target.action, target.settings].filter(Boolean),
      ).toHaveLength(1);
    }
  });
});
