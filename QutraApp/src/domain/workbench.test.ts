import { describe, it, expect } from "vitest";
import {
  WORKBENCH_MODES,
  MODE_ROUTES,
  DEFAULT_MODE,
  firstSegment,
  resolveModeForPath,
  defaultRouteForMode,
  routeForMode,
  clampSize,
  CONTEXT_SIDEBAR,
  CONTEXT_PANEL,
  isLabView,
  resolveLabView,
  LAB_VIEWS,
  TOOLS_VIEWS,
  movedLabView,
  registeredToolsHref,
  resolveToolsView,
  toolsHref,
  MAX_WORKBENCH_TABS,
  MAX_PINNED_WORKBENCH_TABS,
  MAX_RECENTLY_CLOSED,
  normalizeWorkbenchRoute,
  normalizeWorkbenchTabs,
  workbenchItemKey,
  openWorkbenchTab,
  closeWorkbenchTab,
  closeOtherWorkbenchTabs,
  closeUnpinnedWorkbenchTabs,
  toggleWorkbenchTabPinned,
  pushRecentlyClosed,
  popRecentlyClosed,
  createTabHistory,
  visitTab,
  canGoBack,
  canGoForward,
  historyBack,
  historyForward,
  currentHistoryRoute,
  HOME_ROUTE,
  isHomeRoute,
  isTabbableRoute,
} from "./workbench";

describe("workbench mode ↔ navigation mapping", () => {
  it("every mode has at least one route and a stable default", () => {
    for (const mode of WORKBENCH_MODES) {
      expect(MODE_ROUTES[mode].length).toBeGreaterThan(0);
      expect(defaultRouteForMode(mode)).toBe(MODE_ROUTES[mode][0]);
    }
  });

  it("no route is claimed by two modes", () => {
    const seen = new Map<string, string>();
    for (const mode of WORKBENCH_MODES) {
      for (const route of MODE_ROUTES[mode]) {
        expect(seen.has(route)).toBe(false);
        seen.set(route, mode);
      }
    }
  });

  it("resolves the owning mode from exact and nested paths", () => {
    expect(resolveModeForPath("/overview")).toBe("core");
    expect(resolveModeForPath("/workspaces")).toBe("core");
    expect(resolveModeForPath("/workspaces/abc123")).toBe("core");
    expect(resolveModeForPath("/workspaces/abc123/sessions")).toBe("core");
    expect(resolveModeForPath("/files")).toBe("core");
    expect(resolveModeForPath("/terminal")).toBe("core");
    expect(resolveModeForPath("/lab")).toBe("core");
    expect(resolveModeForPath("/lab?view=findings")).toBe("core");
    expect(resolveModeForPath("/tools")).toBe("core");
    expect(resolveModeForPath("/github")).toBe("core");
  });

  it("returns null for unknown / retired paths", () => {
    expect(resolveModeForPath("/onboarding")).toBeNull();
    expect(resolveModeForPath("/does-not-exist")).toBeNull();
    // Settings is a modal over the current surface, no longer a route.
    expect(resolveModeForPath("/settings")).toBeNull();
    expect(resolveModeForPath("/")).toBeNull();
    // Focus mode is a deliberate full-screen surface outside the shell, so it
    // leaves the current sidebar selection intact rather than claiming a mode.
    expect(resolveModeForPath("/sessions/focus")).toBeNull();
    // Retired product surfaces must never resolve to a mode again.
    expect(resolveModeForPath("/notes")).toBeNull();
    expect(resolveModeForPath("/inbox")).toBeNull();
    expect(resolveModeForPath("/errors")).toBeNull();
    expect(resolveModeForPath("/automations")).toBeNull();
  });

  it("firstSegment strips ids, query and hash", () => {
    expect(firstSegment("/lab?view=runs")).toBe("/lab");
    expect(firstSegment("/workspaces/42#top")).toBe("/workspaces");
    expect(firstSegment("/")).toBe("/");
  });

  it("DEFAULT_MODE is a real mode", () => {
    expect(WORKBENCH_MODES).toContain(DEFAULT_MODE);
  });
});

describe("routeForMode (last-route memory)", () => {
  it("returns the remembered route when it still belongs to the mode", () => {
    expect(routeForMode("core", { core: "/tools" })).toBe("/tools");
    expect(routeForMode("core", { core: "/github" })).toBe("/github");
  });

  it("falls back to the default when the remembered route is foreign or stale", () => {
    // A route the shell no longer owns can never strand the user there.
    expect(routeForMode("core", { core: "/notes" })).toBe("/overview");
    expect(routeForMode("core", { core: "/gone" })).toBe("/overview");
    expect(routeForMode("core", undefined)).toBe("/overview");
    expect(routeForMode("core", {})).toBe("/overview");
  });
});

describe("layout size clamping", () => {
  it("clamps into range and rounds", () => {
    expect(clampSize(10, CONTEXT_SIDEBAR)).toBe(CONTEXT_SIDEBAR.min);
    expect(clampSize(9999, CONTEXT_SIDEBAR)).toBe(CONTEXT_SIDEBAR.max);
    expect(clampSize(240.6, CONTEXT_SIDEBAR)).toBe(241);
    expect(clampSize(360, CONTEXT_PANEL)).toBe(360);
    expect(clampSize(200, CONTEXT_PANEL)).toBe(320);
  });

  it("falls back to default for corrupt values", () => {
    expect(clampSize(undefined, CONTEXT_PANEL)).toBe(CONTEXT_PANEL.default);
    expect(clampSize(NaN, CONTEXT_PANEL)).toBe(CONTEXT_PANEL.default);
    expect(clampSize("nonsense", CONTEXT_PANEL)).toBe(CONTEXT_PANEL.default);
    expect(clampSize(null, CONTEXT_SIDEBAR)).toBe(CONTEXT_SIDEBAR.default);
  });
});

describe("lab views", () => {
  it("validates and resolves lab views", () => {
    for (const v of LAB_VIEWS) expect(isLabView(v)).toBe(true);
    expect(isLabView("bogus")).toBe(false);
    expect(isLabView(null)).toBe(false);
    expect(resolveLabView("runs")).toBe("runs");
    expect(resolveLabView("bogus")).toBe("overview");
    expect(resolveLabView(null)).toBe("overview");
  });
});

describe("investigation views", () => {
  it("lists the six sections and Scope, which the strip opens", () => {
    expect(LAB_VIEWS).toEqual(["overview", "targets", "runs", "evidence", "findings", "report", "scope"]);
  });
  it("sends a retired view to the overview", () => {
    expect(resolveLabView("methodology")).toBe("overview");
    expect(resolveLabView("report")).toBe("report");
  });
  it("redirects the views that moved to Tools, keeping investigation and tool", () => {
    expect(movedLabView(new URLSearchParams("e=eng-1&view=tools&tool=t-1"))).toBe(
      "/tools?view=registered&e=eng-1&tool=t-1",
    );
    expect(movedLabView(new URLSearchParams("e=eng-1&view=guides"))).toBe(
      "/tools?view=catalog&e=eng-1",
    );
    expect(movedLabView(new URLSearchParams("e=eng-1&view=runs"))).toBeNull();
  });
});

describe("tools views", () => {
  it("lists the five sections, Toolbox first", () => {
    expect(TOOLS_VIEWS).toEqual(["box", "registered", "catalog", "playbooks", "datasets"]);
    expect(resolveToolsView(null)).toBe("box");
    expect(resolveToolsView("datasets")).toBe("datasets");
    expect(resolveToolsView("nope")).toBe("box");
  });
  it("links to the registered tools for an investigation", () => {
    expect(registeredToolsHref()).toBe("/tools?view=registered");
    expect(registeredToolsHref("eng 1", "t-1")).toBe("/tools?view=registered&e=eng+1&tool=t-1");
  });
  it("keeps the investigation in every Tools section link", () => {
    expect(toolsHref("catalog", "eng-1")).toBe("/tools?view=catalog&e=eng-1");
    expect(toolsHref("box", null)).toBe("/tools?view=box");
  });
});

describe("persistent workbench tabs", () => {
  const tab = (route: string, openedAt: number, pinned = false) => ({
    route,
    openedAt,
    pinned,
  });

  it("accepts only workbench-owned routes and removes hashes", () => {
    expect(normalizeWorkbenchRoute("/files#heading")).toBe("/files");
    expect(normalizeWorkbenchRoute("/lab?e=one&view=runs")).toBe(
      "/lab?e=one&view=runs",
    );
    expect(normalizeWorkbenchRoute("/onboarding")).toBeNull();
    expect(normalizeWorkbenchRoute("https://example.com")).toBeNull();
  });

  it("normalizes stale and duplicate persisted entries", () => {
    expect(
      normalizeWorkbenchTabs([
        tab("/files", 10),
        tab("/files", 20, true),
        tab("/gone", 30),
        tab("/tools#today", Number.NaN),
      ]),
    ).toEqual([tab("/files", 10, true), tab("/tools", 0)]);
  });

  it("separates work-item identity from transient URL state", () => {
    expect(workbenchItemKey("/files?q=report")).toBe("/files");
    expect(workbenchItemKey("/workspaces/project-1/tasks")).toBe(
      "/workspaces/project-1",
    );
    expect(workbenchItemKey("/lab?e=eng-1&view=findings")).toBe(
      "/lab?e=eng-1",
    );
    expect(workbenchItemKey("/lab?e=eng-2&view=findings")).toBe(
      "/lab?e=eng-2",
    );
  });

  it("strips home from persisted tabs — home is the empty-tab fallback", () => {
    expect(isHomeRoute(HOME_ROUTE)).toBe(true);
    expect(isTabbableRoute(HOME_ROUTE)).toBe(false);
    expect(isTabbableRoute("/files")).toBe(true);
    expect(
      normalizeWorkbenchTabs([
        tab("/overview", 1, true),
        tab("/files", 2),
      ]),
    ).toEqual([tab("/files", 2)]);
    expect(openWorkbenchTab([], "/overview", 100)).toEqual([]);
  });

  it("never silently evicts tabs during normal multi-tab use", () => {
    // Opening an 11th distinct route keeps all 11 — the old aggressive
    // 10-tab silent drop is gone; the overflow menu + scroll handle display.
    let tabs = Array.from({ length: 10 }, (_, index) =>
      tab(`/workspaces/project-${index}/overview`, index),
    );
    tabs = openWorkbenchTab(tabs, "/github", 100);
    expect(tabs).toHaveLength(11);
    expect(tabs.at(-1)?.route).toBe("/github");
    expect(tabs[0]?.route).toBe("/workspaces/project-0/overview");
  });

  it("re-activates an existing tab instead of opening a duplicate", () => {
    const tabs = [tab("/github", 1), tab("/files", 2), tab("/tools", 3)];
    const again = openWorkbenchTab(tabs, "/files", 999);
    // No new entry, order and identity preserved (the caller just navigates).
    expect(again.map((t) => t.route)).toEqual(["/github", "/files", "/tools"]);
    expect(again).toHaveLength(3);
  });

  it("updates an existing work item when only its URL state changes", () => {
    const tabs = [
      tab("/files?q=old", 1, true),
      tab("/lab?e=eng-1&view=scope", 2),
    ];
    const files = openWorkbenchTab(tabs, "/files?q=new", 999);
    const lab = openWorkbenchTab(files, "/lab?e=eng-1&view=findings", 1000);

    expect(lab).toEqual([
      tab("/files?q=new", 1, true),
      tab("/lab?e=eng-1&view=findings", 2),
    ]);
  });

  it("clamps only at the absolute safety ceiling, dropping the oldest unpinned", () => {
    const tabs = Array.from({ length: MAX_WORKBENCH_TABS }, (_, index) =>
      tab(`/workspaces/project-${index}/overview`, index),
    );
    const next = openWorkbenchTab(tabs, "/github", 9999);
    expect(next).toHaveLength(MAX_WORKBENCH_TABS);
    expect(next.some((t) => t.route === "/github")).toBe(true);
    expect(next.some((t) => t.openedAt === 0)).toBe(false); // oldest evicted
  });

  it("keeps pinned tabs even at the safety ceiling", () => {
    const tabs = Array.from({ length: MAX_WORKBENCH_TABS }, (_, index) =>
      tab(`/workspaces/project-${index}/overview`, index, index === 0),
    );
    const next = openWorkbenchTab(tabs, "/github", 9999);
    expect(next.some((t) => t.route === "/workspaces/project-0/overview")).toBe(true);
    expect(next.some((t) => t.route === "/github")).toBe(true);
  });

  it("preserves pinned tabs and supports close operations", () => {
    const tabs = [
      tab("/github", 1, true),
      tab("/files", 2),
      tab("/tools", 3),
    ];
    expect(toggleWorkbenchTabPinned(tabs, "/files")[1].pinned).toBe(true);
    expect(closeWorkbenchTab(tabs, "/files").map((item) => item.route)).toEqual([
      "/github",
      "/tools",
    ]);
    expect(closeOtherWorkbenchTabs(tabs, "/tools").map((item) => item.route)).toEqual([
      "/github",
      "/tools",
    ]);
    expect(closeUnpinnedWorkbenchTabs(tabs)).toEqual([tab("/github", 1, true)]);
  });

  it("caps the pinned working set and normalizes excessive persisted pins", () => {
    const tabs = Array.from(
      { length: MAX_PINNED_WORKBENCH_TABS + 2 },
      (_, index) => tab(`/workspaces/project-${index}`, index, true),
    );
    const normalized = normalizeWorkbenchTabs(tabs);
    expect(normalized.filter((item) => item.pinned)).toHaveLength(
      MAX_PINNED_WORKBENCH_TABS,
    );
    const attempted = toggleWorkbenchTabPinned(
      normalized,
      normalized.at(-1)!.route,
    );
    expect(attempted.filter((item) => item.pinned)).toHaveLength(
      MAX_PINNED_WORKBENCH_TABS,
    );
  });

  it("closing the last tab yields an empty set (caller navigates home)", () => {
    const tabs = [tab("/files", 1)];
    expect(closeWorkbenchTab(tabs, "/files")).toEqual([]);
  });
});

describe("recently closed tabs (Ctrl+Shift+T)", () => {
  it("pushes closed routes most-recent-first, de-duplicated", () => {
    let list = pushRecentlyClosed([], "/files");
    list = pushRecentlyClosed(list, "/tools");
    list = pushRecentlyClosed(list, "/files"); // re-closing moves it to front
    expect(list).toEqual(["/files", "/tools"]);
  });

  it("ignores routes that are not workbench-owned", () => {
    expect(pushRecentlyClosed([], "/onboarding")).toEqual([]);
    expect(pushRecentlyClosed([], "https://x.com")).toEqual([]);
  });

  it("bounds the stack to MAX_RECENTLY_CLOSED", () => {
    let list: string[] = [];
    for (let i = 0; i < MAX_RECENTLY_CLOSED + 5; i++) {
      list = pushRecentlyClosed(list, `/files?q=${i}`);
    }
    expect(list).toHaveLength(MAX_RECENTLY_CLOSED);
    expect(list[0]).toBe(`/files?q=${MAX_RECENTLY_CLOSED + 4}`);
  });

  it("pops the most recently closed route", () => {
    const { route, rest } = popRecentlyClosed(["/files", "/tools"]);
    expect(route).toBe("/files");
    expect(rest).toEqual(["/tools"]);
    expect(popRecentlyClosed([])).toEqual({ route: null, rest: [] });
  });
});

describe("workbench tab history (separate from router history)", () => {
  it("starts empty with no navigation available", () => {
    const h = createTabHistory();
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
    expect(currentHistoryRoute(h)).toBeNull();
  });

  it("records visits and enables back once there is somewhere to go", () => {
    let h = createTabHistory();
    h = visitTab(h, "/overview");
    expect(canGoBack(h)).toBe(false);
    h = visitTab(h, "/files");
    expect(canGoBack(h)).toBe(true);
    expect(canGoForward(h)).toBe(false);
    expect(currentHistoryRoute(h)).toBe("/files");
  });

  it("goes back and forward through the visit stack", () => {
    let h = createTabHistory();
    h = visitTab(h, "/overview");
    h = visitTab(h, "/files");
    h = visitTab(h, "/tools");
    h = historyBack(h);
    expect(currentHistoryRoute(h)).toBe("/files");
    expect(canGoForward(h)).toBe(true);
    h = historyBack(h);
    expect(currentHistoryRoute(h)).toBe("/overview");
    expect(canGoBack(h)).toBe(false);
    h = historyForward(h);
    expect(currentHistoryRoute(h)).toBe("/files");
  });

  it("visiting after going back truncates the forward entries", () => {
    let h = createTabHistory();
    h = visitTab(h, "/overview");
    h = visitTab(h, "/files");
    h = historyBack(h); // now at /overview, forward=/notes
    h = visitTab(h, "/tools"); // replaces the forward branch
    expect(canGoForward(h)).toBe(false);
    expect(currentHistoryRoute(h)).toBe("/tools");
    h = historyBack(h);
    expect(currentHistoryRoute(h)).toBe("/overview");
  });

  it("ignores a repeated visit to the current route", () => {
    let h = createTabHistory();
    h = visitTab(h, "/files");
    h = visitTab(h, "/files");
    expect(canGoBack(h)).toBe(false);
  });

});
