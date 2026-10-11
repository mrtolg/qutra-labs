/* Overview aggregation + customizable-layout logic.
   Pure functions only — fully unit-tested without React or the DB. */

import type { RestoreRun, Task } from "./types";

/** Sections the Overview can render, in their default order. */
export const OVERVIEW_SECTIONS = [
  "resume",
  "session",
  "attention",
  "recent",
  "activity",
  "restoreHealth",
  "github",
  "privacy",
] as const;

export type OverviewSectionId = (typeof OVERVIEW_SECTIONS)[number];

/**
 * Sections that stay useful even when the user is customizing aggressively.
 * They can be reordered but never permanently hidden — the resume action and
 * the privacy/capture control are the product's spine.
 */
export const PROTECTED_SECTIONS: ReadonlySet<OverviewSectionId> = new Set([
  "resume",
  "privacy",
]);

export interface OverviewLayoutEntry {
  id: OverviewSectionId;
  hidden: boolean;
}

const isKnown = (id: string): id is OverviewSectionId =>
  (OVERVIEW_SECTIONS as readonly string[]).includes(id);

/**
 * Reconcile a persisted layout with the current section catalog:
 * - keep the saved order for sections that still exist;
 * - append any new sections (visible) at the end so upgrades never hide them;
 * - drop unknown/removed ids;
 * - force protected sections visible regardless of stored state.
 */
export function resolveOverviewLayout(
  saved: readonly { id: string; hidden?: boolean }[] | undefined,
): OverviewLayoutEntry[] {
  const seen = new Set<OverviewSectionId>();
  const resolved: OverviewLayoutEntry[] = [];
  for (const entry of saved ?? []) {
    if (!isKnown(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    resolved.push({
      id: entry.id,
      hidden: PROTECTED_SECTIONS.has(entry.id) ? false : entry.hidden === true,
    });
  }
  for (const id of OVERVIEW_SECTIONS) {
    if (!seen.has(id)) resolved.push({ id, hidden: false });
  }
  return resolved;
}

/** Move a section up (dir=-1) or down (dir=1); returns a new array. */
export function moveOverviewSection(
  layout: readonly OverviewLayoutEntry[],
  id: OverviewSectionId,
  dir: -1 | 1,
): OverviewLayoutEntry[] {
  const idx = layout.findIndex((e) => e.id === id);
  const next = idx + dir;
  if (idx < 0 || next < 0 || next >= layout.length) return [...layout];
  const copy = [...layout];
  [copy[idx], copy[next]] = [copy[next], copy[idx]];
  return copy;
}

/** Toggle visibility; protected sections can never be hidden. */
export function toggleOverviewSection(
  layout: readonly OverviewLayoutEntry[],
  id: OverviewSectionId,
): OverviewLayoutEntry[] {
  return layout.map((e) =>
    e.id === id && !PROTECTED_SECTIONS.has(id)
      ? { ...e, hidden: !e.hidden }
      : e,
  );
}

export interface RestoreHealth {
  success: number;
  partial: number;
  failed: number;
  total: number;
  /** 0..1 success ratio over completed (non-running) runs, or null if none. */
  successRate: number | null;
}

/** Summarize restore-run outcomes. `cancelled`/`running` are excluded from
 *  the success ratio because they are not health signals. */
export function computeRestoreHealth(
  runs: readonly RestoreRun[],
): RestoreHealth {
  let success = 0;
  let partial = 0;
  let failed = 0;
  for (const r of runs) {
    if (r.status === "completed") success++;
    else if (r.status === "partial") partial++;
    else if (r.status === "failed") failed++;
  }
  const total = success + partial + failed;
  return {
    success,
    partial,
    failed,
    total,
    successRate: total === 0 ? null : success / total,
  };
}

export interface AttentionSummary {
  overdue: number;
  dueToday: number;
  blocked: number;
  /** True when nothing needs attention — drives the calm empty state. */
  clear: boolean;
}

/** Count the things pulling for attention right now. `now` is injectable so
 *  the "today" window is deterministic in tests. */
export function computeAttention(
  tasks: readonly Task[],
  now: number,
): AttentionSummary {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const start = dayStart.getTime();
  const end = start + 86_400_000;
  const openTasks = tasks.filter(
    (t) => t.status !== "done" && t.status !== "archived",
  );
  let overdue = 0;
  let dueToday = 0;
  for (const t of openTasks) {
    if (t.dueAt === undefined) continue;
    if (t.dueAt < start) overdue++;
    else if (t.dueAt < end) dueToday++;
  }
  const openIds = new Set(openTasks.map((t) => t.id));
  const blocked = openTasks.filter((t) =>
    t.blockedByIds.some((b) => openIds.has(b)),
  ).length;
  return {
    overdue,
    dueToday,
    blocked,
    clear: overdue + dueToday + blocked === 0,
  };
}
