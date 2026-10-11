/* ============================================================
   Workbench shell model (pure).

   The product has a single core mode with nine top-level routes. This
   module is the framework-free source of truth for:

   - which application routes are product destinations,
   - resolving mode ownership from the current path,
   - the default / last route for a mode,
   - clamping persisted layout sizes to safe bounds,
   - the Lab sub-view enumeration,
   - persistent working tabs and navigation history helpers.

   It is exhaustively unit-tested and imported by the shell components and
   the preferences layer. No React, no i18n, no icons here on purpose.
   ============================================================ */

export const WORKBENCH_MODES = ["core"] as const;
export type WorkbenchMode = (typeof WORKBENCH_MODES)[number];

export const DEFAULT_MODE: WorkbenchMode = "core";

/**
 * Product home / main screen. Not a working tab — navigating here (or closing
 * the last tab) lands on this route with an empty tab strip, like a VS Code
 * empty editor group falling back to Welcome.
 */
export const HOME_ROUTE = "/overview";

/**
 * Top-level routes owned by each mode. The FIRST entry is the mode's
 * default landing route. Only routes that actually exist in the router are
 * listed — the sidebar never links anywhere real navigation cannot follow.
 * `lab` and `tools` live under `lab` but are only reachable when the private
 * lab is enabled (enforced by the caller, not here).
 */
export const MODE_ROUTES: Record<WorkbenchMode, readonly string[]> = {
  core: [
    HOME_ROUTE,
    "/workspaces",
    "/files",
    "/tools",
    "/lab",
    "/terminal",
    "/github",
    "/jarvis",
  ],
};

/** True when the path is the home/main screen (not a working tab). */
export function isHomeRoute(route: string): boolean {
  return firstSegment(route) === HOME_ROUTE;
}

/** Working tabs exclude home — home is the empty-tab fallback surface. */
export function isTabbableRoute(route: string): boolean {
  const normalized = normalizeWorkbenchRoute(route);
  return Boolean(normalized && !isHomeRoute(normalized));
}

/** First path segment ("/workspaces") → owning mode, built once. */
const SEGMENT_TO_MODE = new Map<string, WorkbenchMode>();
for (const mode of WORKBENCH_MODES) {
  for (const route of MODE_ROUTES[mode]) {
    SEGMENT_TO_MODE.set(route, mode);
  }
}

/** Normalize any path to its first segment, e.g. "/workspaces/42/tab" → "/workspaces". */
export function firstSegment(path: string): string {
  const clean = path.split(/[?#]/)[0];
  const seg = clean.split("/").filter(Boolean)[0];
  return seg ? `/${seg}` : "/";
}

/**
 * Resolve which mode owns a path. Returns null for unknown paths (e.g. the
 * onboarding route or a 404) so the caller can leave the current mode intact.
 */
export function resolveModeForPath(path: string): WorkbenchMode | null {
  return SEGMENT_TO_MODE.get(firstSegment(path)) ?? null;
}

/** The default landing route for a mode. */
export function defaultRouteForMode(mode: WorkbenchMode): string {
  return MODE_ROUTES[mode][0];
}

/**
 * Resolve the route to open when a mode is selected: the last visited route
 * for that mode if it still belongs to the mode, otherwise the mode default.
 * A stale/foreign persisted value can never send a mode to the wrong screen.
 */
export function routeForMode(
  mode: WorkbenchMode,
  lastRoutes: Record<string, string> | undefined,
): string {
  const last = lastRoutes?.[mode];
  if (last && resolveModeForPath(last) === mode) return last;
  return defaultRouteForMode(mode);
}

/* ---------- Persistent working tabs ---------- */

export interface WorkbenchTabState {
  route: string;
  pinned: boolean;
  openedAt: number;
}

/**
 * Absolute safety ceiling for the working set. This is NOT an aggressive
 * "keep it tidy" cap — normal multi-tab use never hits it. It only guards the
 * persisted preferences (schema-capped at 24) from unbounded growth. Display
 * of many tabs is handled by horizontal scroll + the overflow menu, never by
 * silently dropping tabs the user is still working with.
 */
export const MAX_WORKBENCH_TABS = 24;

/** Pinning is an explicit compact working set, not an unlimited archive. */
export const MAX_PINNED_WORKBENCH_TABS = 12;

/** How many recently-closed tabs to remember for reopen (Ctrl+Shift+T). */
export const MAX_RECENTLY_CLOSED = 12;

/** Return a canonical, workbench-owned route or null for unsafe/stale input. */
export function normalizeWorkbenchRoute(route: string): string | null {
  if (typeof route !== "string" || !route.startsWith("/")) return null;
  const withoutHash = route.split("#", 1)[0];
  if (!resolveModeForPath(withoutHash)) return null;
  return withoutHash;
}

/**
 * Stable document identity for a route. Filters, selected sub-views and search
 * queries update an existing work item instead of creating another tab.
 */
export function workbenchItemKey(route: string): string | null {
  const normalized = normalizeWorkbenchRoute(route);
  if (!normalized || isHomeRoute(normalized)) return null;
  const url = new URL(normalized, "https://contextos.local");
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "workspaces" && segments[1]) {
    return `/workspaces/${encodeURIComponent(segments[1])}`;
  }
  if (segments[0] === "lab") {
    const engagementId = url.searchParams.get("e");
    return engagementId
      ? `/lab?e=${encodeURIComponent(engagementId)}`
      : "/lab";
  }
  return firstSegment(url.pathname);
}

/** Remove stale routes, home, and duplicate work items, preserving order. */
export function normalizeWorkbenchTabs(
  tabs: readonly WorkbenchTabState[],
): WorkbenchTabState[] {
  const indexByKey = new Map<string, number>();
  const result: WorkbenchTabState[] = [];
  for (const tab of tabs) {
    const route = normalizeWorkbenchRoute(tab.route);
    const key = route ? workbenchItemKey(route) : null;
    if (!route || !key) continue;
    const normalized = {
      route,
      pinned: Boolean(tab.pinned),
      openedAt:
        Number.isFinite(tab.openedAt) && tab.openedAt >= 0
          ? Math.round(tab.openedAt)
          : 0,
    };
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push(normalized);
    } else {
      const existing = result[existingIndex];
      result[existingIndex] = {
        ...normalized,
        pinned: existing.pinned || normalized.pinned,
        openedAt: Math.min(existing.openedAt, normalized.openedAt),
      };
    }
  }

  let pinned = 0;
  for (const tab of result) {
    if (!tab.pinned) continue;
    pinned += 1;
    if (pinned > MAX_PINNED_WORKBENCH_TABS) tab.pinned = false;
  }
  return result;
}

export function openWorkbenchTab(
  tabs: readonly WorkbenchTabState[],
  route: string,
  openedAt = Date.now(),
): WorkbenchTabState[] {
  const normalizedRoute = normalizeWorkbenchRoute(route);
  const normalized = normalizeWorkbenchTabs(tabs);
  const itemKey = normalizedRoute
    ? workbenchItemKey(normalizedRoute)
    : null;
  // Refuse home and unknown routes — closing the last tab must not bounce
  // back into a sticky Overview tab.
  if (!normalizedRoute || !itemKey) {
    return normalized;
  }
  const existingIndex = normalized.findIndex(
    (tab) => workbenchItemKey(tab.route) === itemKey,
  );
  if (existingIndex >= 0) {
    if (normalized[existingIndex].route === normalizedRoute) return normalized;
    return normalized.map((tab, index) =>
      index === existingIndex ? { ...tab, route: normalizedRoute } : tab,
    );
  }

  const next = [
    ...normalized,
    { route: normalizedRoute, pinned: false, openedAt },
  ];
  // No eviction during normal use. Only when the absolute safety ceiling is
  // exceeded do we drop the single oldest UNPINNED tab (pinned tabs are never
  // evicted). This effectively never happens below MAX_WORKBENCH_TABS.
  if (next.length <= MAX_WORKBENCH_TABS) return next;

  const unpinned = next.filter((tab) => !tab.pinned);
  if (unpinned.length === 0) return next; // all pinned — keep them all
  const oldest = unpinned.reduce((candidate, tab) =>
    tab.openedAt < candidate.openedAt ? tab : candidate,
  );
  return next.filter((tab) => tab.route !== oldest.route);
}

/* ---------- Recently closed (reopen with Ctrl+Shift+T) ---------- */

/**
 * Push a just-closed route onto the recently-closed stack, most-recent-first.
 * Non-workbench routes are ignored; duplicates move to the front; the stack is
 * bounded so it can never grow without limit.
 */
export function pushRecentlyClosed(
  list: readonly string[],
  route: string,
  cap = MAX_RECENTLY_CLOSED,
): string[] {
  const normalized = normalizeWorkbenchRoute(route);
  if (!normalized) return [...list];
  const withoutDupe = list.filter((entry) => entry !== normalized);
  return [normalized, ...withoutDupe].slice(0, Math.max(0, cap));
}

/** Pop the most recently closed route off the stack. */
export function popRecentlyClosed(list: readonly string[]): {
  route: string | null;
  rest: string[];
} {
  if (list.length === 0) return { route: null, rest: [] };
  const [route, ...rest] = list;
  return { route, rest };
}

/* ---------- Workbench tab history (Back / Forward) ----------

   Separate from the router's history so the arrows step through the tabs the
   user actually visited in this workbench, not every low-level navigation.
   A simple entries + index cursor, like a browser's per-tab history. */

export interface TabHistory {
  entries: readonly string[];
  index: number;
}

const MAX_TAB_HISTORY = 50;

export function createTabHistory(route?: string): TabHistory {
  const start = route ? normalizeWorkbenchRoute(route) : null;
  return start ? { entries: [start], index: 0 } : { entries: [], index: -1 };
}

export function currentHistoryRoute(history: TabHistory): string | null {
  return history.entries[history.index] ?? null;
}

export function canGoBack(history: TabHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: TabHistory): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1;
}

/**
 * Record a visit. Repeating the current route is a no-op; visiting after going
 * back truncates the forward branch (browser semantics). Bounded length.
 */
export function visitTab(history: TabHistory, route: string): TabHistory {
  const normalized = normalizeWorkbenchRoute(route);
  if (!normalized) return history;
  if (currentHistoryRoute(history) === normalized) return history;
  const kept = history.entries.slice(0, history.index + 1);
  const grown = [...kept, normalized];
  const trimmed =
    grown.length > MAX_TAB_HISTORY ? grown.slice(grown.length - MAX_TAB_HISTORY) : grown;
  return { entries: trimmed, index: trimmed.length - 1 };
}

export function historyBack(history: TabHistory): TabHistory {
  return canGoBack(history) ? { ...history, index: history.index - 1 } : history;
}

export function historyForward(history: TabHistory): TabHistory {
  return canGoForward(history) ? { ...history, index: history.index + 1 } : history;
}

export function closeWorkbenchTab(
  tabs: readonly WorkbenchTabState[],
  route: string,
): WorkbenchTabState[] {
  return normalizeWorkbenchTabs(tabs).filter((tab) => tab.route !== route);
}

export function closeOtherWorkbenchTabs(
  tabs: readonly WorkbenchTabState[],
  route: string,
): WorkbenchTabState[] {
  return normalizeWorkbenchTabs(tabs).filter(
    (tab) => tab.route === route || tab.pinned,
  );
}

export function closeUnpinnedWorkbenchTabs(
  tabs: readonly WorkbenchTabState[],
): WorkbenchTabState[] {
  return normalizeWorkbenchTabs(tabs).filter((tab) => tab.pinned);
}

export function toggleWorkbenchTabPinned(
  tabs: readonly WorkbenchTabState[],
  route: string,
): WorkbenchTabState[] {
  const normalized = normalizeWorkbenchTabs(tabs);
  const target = normalized.find((tab) => tab.route === route);
  if (!target) return normalized;
  if (
    !target.pinned &&
    normalized.filter((tab) => tab.pinned).length >=
      MAX_PINNED_WORKBENCH_TABS
  ) {
    return normalized;
  }
  return normalized.map((tab) =>
    tab.route === route ? { ...tab, pinned: !tab.pinned } : tab,
  );
}

/* ---------- Layout size bounds (px) ---------- */

export const CONTEXT_SIDEBAR = { min: 200, max: 360, default: 240 } as const;
export const CONTEXT_PANEL = { min: 320, max: 480, default: 360 } as const;

/** Clamp a possibly-corrupt persisted size into a usable range. */
export function clampSize(
  value: unknown,
  bounds: { min: number; max: number; default: number },
): number {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  else return bounds.default;
  if (!Number.isFinite(n)) return bounds.default;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
}

/* ---------- Investigation sub-views ----------
   The six sections under the top bar, in order, then Scope, which the
   scope strip opens (spec 2026-10-07 §5.1). Methodology folded into the
   Overview; Tools and Guides moved to the Tools area. */

export const LAB_VIEWS = [
  "overview",
  "targets",
  "runs",
  "evidence",
  "findings",
  "report",
  "scope",
] as const;
export type LabView = (typeof LAB_VIEWS)[number];

export function isLabView(value: string | null | undefined): value is LabView {
  return !!value && (LAB_VIEWS as readonly string[]).includes(value);
}

export function resolveLabView(value: string | null | undefined): LabView {
  return isLabView(value) ? value : "overview";
}

/** Where an old `/lab?view=tools|guides` link goes now; null for any other view. */
export function movedLabView(params: URLSearchParams): string | null {
  const view = params.get("view");
  if (view === "guides") return toolsHref("catalog", params.get("e"));
  if (view !== "tools") return null;
  return toolsHref("registered", params.get("e"), params.get("tool"));
}

/* ---------- Tools sub-views ---------- */

export const TOOLS_VIEWS = ["box", "registered", "catalog", "playbooks", "datasets"] as const;
export type ToolsView = (typeof TOOLS_VIEWS)[number];

export function resolveToolsView(value: string | null | undefined): ToolsView {
  return value && (TOOLS_VIEWS as readonly string[]).includes(value) ? (value as ToolsView) : "box";
}

/** A Tools section, still naming the investigation it was opened for (`e`):
    without it, Registered tools would fall back to the newest investigation
    and run against its targets and scope. */
export function toolsHref(
  view: ToolsView,
  engagementId?: string | null,
  toolId?: string | null,
): string {
  const params = new URLSearchParams({ view });
  if (engagementId) params.set("e", engagementId);
  if (toolId) params.set("tool", toolId);
  return `/tools?${params.toString()}`;
}

/** The registered tools, running against one investigation's targets. */
export function registeredToolsHref(engagementId?: string | null, toolId?: string | null): string {
  return toolsHref("registered", engagementId, toolId);
}
