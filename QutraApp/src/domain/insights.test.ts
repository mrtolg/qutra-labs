import { describe, expect, it } from "vitest";
import {
  activityByDay,
  medianResumeMinutes,
  repeatedInterruptions,
  restoreStats,
  staleWorkspaces,
} from "./insights";
import type { ActivityEvent, RestoreRun, Session, Workspace } from "./types";

const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({
  id: Math.random().toString(),
  type: "session_ended",
  at: Date.now(),
  label: "",
  detail: "",
  minutes: 0,
  demo: false,
  ...over,
});

describe("activityByDay", () => {
  it("buckets minutes and completions into the requested day range", () => {
    const nowMs = Date.now();
    const events = [
      ev({ type: "session_ended", at: nowMs, minutes: 60 }),
      ev({ type: "task_completed", at: nowMs }),
      ev({ type: "session_ended", at: nowMs - 8 * 86_400_000, minutes: 45 }), // outside 7d
    ];
    const days = activityByDay(events, 7, nowMs);
    expect(days).toHaveLength(7);
    const today = days[6];
    expect(today.minutes).toBe(60);
    expect(today.sessions).toBe(1);
    expect(today.tasksCompleted).toBe(1);
    expect(days.reduce((s, d) => s + d.minutes, 0)).toBe(60);
  });
});

describe("staleWorkspaces", () => {
  it("flags only active workspaces idle beyond the threshold", () => {
    const mk = (id: string, idleDays: number, status: Workspace["status"]): Workspace =>
      ({
        id,
        name: id,
        color: "",
        icon: "",
        purpose: "",
        type: "other",
        status,
        favorite: false,
        tags: [],
        defaultCommands: [],
        environmentLabels: [],
        ignoredPaths: [],
        browserCollections: [],
        restoreBehavior: "ask",
        health: "ready",
        demo: false,
        createdAt: 0,
        updatedAt: 0,
        lastActivityAt: Date.now() - idleDays * 86_400_000,
      }) as Workspace;

    const result = staleWorkspaces(
      [mk("fresh", 2, "active"), mk("stale", 10, "active"), mk("arch", 40, "archived")],
      7,
    );
    expect(result.map((r) => r.workspace.id)).toEqual(["stale"]);
  });
});

describe("medianResumeMinutes", () => {
  it("computes the median gap between open and session start", () => {
    const base = Date.now();
    const events = [
      ev({ type: "workspace_opened", at: base, workspaceId: "w" }),
      ev({ type: "session_started", at: base + 10 * 60_000, workspaceId: "w" }),
      ev({ type: "workspace_opened", at: base + 3_600_000 * 2, workspaceId: "w" }),
      ev({ type: "session_started", at: base + 3_600_000 * 2 + 20 * 60_000, workspaceId: "w" }),
    ];
    expect(medianResumeMinutes(events)).toBe(15);
  });
  it("returns null with no pairs", () => {
    expect(medianResumeMinutes([])).toBeNull();
  });
});

describe("repeatedInterruptions", () => {
  it("counts case-insensitive repeated reasons", () => {
    const session = (reasons: string[]): Session =>
      ({
        id: Math.random().toString(),
        workspaceId: "w",
        title: "s",
        intendedOutcome: "",
        status: "completed",
        pausedTotalMs: 0,
        linkedTaskIds: [],
        resourceIds: [],
        distractionTracking: true,
        autoSnapshot: "off",
        interruptions: reasons.map((r, i) => ({
          id: `${i}`,
          at: 0,
          reason: r,
          minutes: 5,
        })),
        demo: false,
        createdAt: 0,
        updatedAt: 0,
      }) as Session;

    const result = repeatedInterruptions(
      [session(["Slack alarm", "phone"]), session(["slack alarm"])],
      2,
    );
    expect(result).toEqual([{ reason: "slack alarm", count: 2 }]);
  });
});

describe("restoreStats", () => {
  it("aggregates run outcomes and failure reasons", () => {
    const runs: RestoreRun[] = [
      {
        id: "1",
        snapshotId: "s",
        workspaceId: "w",
        startedAt: 0,
        status: "completed",
        simulated: true,
        items: [{ itemId: "a", state: "restored" }],
        demo: false,
      },
      {
        id: "2",
        snapshotId: "s",
        workspaceId: "w",
        startedAt: 0,
        status: "partial",
        simulated: true,
        items: [
          { itemId: "a", state: "failed", reason: "timeout" },
          { itemId: "b", state: "permission_required", reason: "elevation_required" },
          { itemId: "c", state: "failed", reason: "timeout" },
        ],
        demo: false,
      },
    ];
    const stats = restoreStats(runs);
    expect(stats.total).toBe(2);
    expect(stats.completed).toBe(1);
    expect(stats.partial).toBe(1);
    expect(stats.failedItems).toBe(3);
    expect(stats.topReasons[0]).toEqual({ reason: "timeout", count: 2 });
  });
});
