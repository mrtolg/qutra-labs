import { describe, expect, it } from "vitest";
import {
  OVERVIEW_SECTIONS,
  resolveOverviewLayout,
  moveOverviewSection,
  toggleOverviewSection,
  computeRestoreHealth,
  computeAttention,
  type OverviewLayoutEntry,
} from "./overview";
import type { RestoreRun, Task } from "./types";

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: "t",
    title: "t",
    workspaceId: "w",
    status: "todo",
    blockedByIds: [],
    ...over,
  }) as Task;

describe("overview layout resolution", () => {
  it("returns every section, in default order, for an empty saved layout", () => {
    const resolved = resolveOverviewLayout(undefined);
    expect(resolved.map((e) => e.id)).toEqual([...OVERVIEW_SECTIONS]);
    expect(resolved.every((e) => !e.hidden)).toBe(true);
  });

  it("keeps saved order and appends newly-added sections at the end", () => {
    const saved = [
      { id: "activity", hidden: false },
      { id: "resume", hidden: false },
    ];
    const resolved = resolveOverviewLayout(saved);
    expect(resolved[0].id).toBe("activity");
    expect(resolved[1].id).toBe("resume");
    // Everything else still present exactly once.
    expect(new Set(resolved.map((e) => e.id)).size).toBe(OVERVIEW_SECTIONS.length);
  });

  it("drops unknown ids and de-duplicates", () => {
    const resolved = resolveOverviewLayout([
      { id: "bogus", hidden: false },
      { id: "activity", hidden: true },
      { id: "activity", hidden: false },
    ]);
    expect(resolved.find((e) => e.id === "activity")?.hidden).toBe(true);
    expect(resolved.filter((e) => e.id === "activity")).toHaveLength(1);
    expect(resolved.some((e) => (e.id as string) === "bogus")).toBe(false);
  });

  it("forces protected sections visible even if stored hidden", () => {
    const resolved = resolveOverviewLayout([
      { id: "resume", hidden: true },
      { id: "privacy", hidden: true },
    ]);
    expect(resolved.find((e) => e.id === "resume")?.hidden).toBe(false);
    expect(resolved.find((e) => e.id === "privacy")?.hidden).toBe(false);
  });
});

describe("overview section reorder + toggle", () => {
  const base: OverviewLayoutEntry[] = resolveOverviewLayout(undefined);

  it("moves a section down and up without losing entries", () => {
    const down = moveOverviewSection(base, "session", 1);
    expect(down.indexOf(down.find((e) => e.id === "session")!)).toBe(2);
    const back = moveOverviewSection(down, "session", -1);
    expect(back.map((e) => e.id)).toEqual(base.map((e) => e.id));
  });

  it("is a no-op at the edges", () => {
    const first = base[0].id;
    expect(moveOverviewSection(base, first, -1).map((e) => e.id)).toEqual(
      base.map((e) => e.id),
    );
  });

  it("hides non-protected sections but refuses to hide protected ones", () => {
    const hidden = toggleOverviewSection(base, "activity");
    expect(hidden.find((e) => e.id === "activity")?.hidden).toBe(true);
    const stillVisible = toggleOverviewSection(base, "resume");
    expect(stillVisible.find((e) => e.id === "resume")?.hidden).toBe(false);
  });
});

describe("computeRestoreHealth", () => {
  const run = (status: RestoreRun["status"]): RestoreRun =>
    ({
      id: status,
      snapshotId: "s",
      workspaceId: "w",
      startedAt: 0,
      status,
      items: [],
      simulated: true,
      demo: false,
    }) as RestoreRun;

  it("returns null success rate with no completed runs", () => {
    expect(computeRestoreHealth([]).successRate).toBeNull();
    expect(computeRestoreHealth([run("running"), run("cancelled")]).total).toBe(0);
  });

  it("counts outcomes and computes an honest success ratio", () => {
    const h = computeRestoreHealth([
      run("completed"),
      run("completed"),
      run("partial"),
      run("failed"),
    ]);
    expect(h).toMatchObject({ success: 2, partial: 1, failed: 1, total: 4 });
    expect(h.successRate).toBeCloseTo(0.5);
  });
});

describe("computeAttention", () => {
  const now = new Date("2026-07-23T12:00:00Z").getTime();

  it("counts overdue, due-today and blocked tasks", () => {
    const yesterday = now - 86_400_000;
    const laterToday = now + 3_600_000;
    const tasks = [
      task({ id: "a", dueAt: yesterday }),
      task({ id: "b", dueAt: laterToday }),
      task({ id: "c", blockedByIds: ["a"] }),
      task({ id: "done", status: "done", dueAt: yesterday }),
    ];
    const s = computeAttention(tasks, now);
    expect(s).toMatchObject({ overdue: 1, dueToday: 1, blocked: 1 });
    expect(s.clear).toBe(false);
  });

  it("reports clear when nothing is pending", () => {
    expect(computeAttention([], now).clear).toBe(true);
  });

  it("ignores blockers that are already done", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "c", blockedByIds: ["a"] }),
    ];
    expect(computeAttention(tasks, now).blocked).toBe(0);
  });
});
