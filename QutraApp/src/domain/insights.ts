import type { ActivityEvent, RestoreRun, Session, Task, Workspace } from "./types";
import { startOfDay } from "@/lib/time";

/* ============================================================
   Insights: honest aggregations over real events.
   No invented productivity scores, no streaks.
   ============================================================ */

export interface DayActivity {
  day: number; // startOfDay ts
  sessions: number;
  minutes: number;
  tasksCompleted: number;
  events: number;
}

export function activityByDay(
  events: ActivityEvent[],
  days: number,
  nowMs: number = Date.now(),
): DayActivity[] {
  const out: DayActivity[] = [];
  const today = startOfDay(nowMs);
  for (let i = days - 1; i >= 0; i--) {
    const day = today - i * 86_400_000;
    out.push({ day, sessions: 0, minutes: 0, tasksCompleted: 0, events: 0 });
  }
  const index = new Map(out.map((d, i) => [d.day, i]));
  for (const e of events) {
    const day = startOfDay(e.at);
    const i = index.get(day);
    if (i === undefined) continue;
    const bucket = out[i];
    bucket.events++;
    if (e.type === "session_ended" || e.type === "session_started") {
      if (e.type === "session_ended") bucket.sessions++;
      bucket.minutes += e.minutes;
    } else if (e.type === "task_completed") {
      bucket.tasksCompleted++;
    }
  }
  return out;
}

export interface StaleWorkspace {
  workspace: Workspace;
  idleDays: number;
}

export function staleWorkspaces(
  workspaces: Workspace[],
  thresholdDays = 7,
  nowMs: number = Date.now(),
): StaleWorkspace[] {
  return workspaces
    .filter((w) => w.status === "active")
    .map((w) => ({
      workspace: w,
      idleDays: Math.floor((nowMs - w.lastActivityAt) / 86_400_000),
    }))
    .filter((s) => s.idleDays >= thresholdDays)
    .sort((a, b) => b.idleDays - a.idleDays);
}

/** Median minutes between opening a workspace and starting a session. */
export function medianResumeMinutes(events: ActivityEvent[]): number | null {
  const gaps: number[] = [];
  const opens = events
    .filter((e) => e.type === "workspace_opened")
    .sort((a, b) => a.at - b.at);
  const starts = events
    .filter((e) => e.type === "session_started")
    .sort((a, b) => a.at - b.at);
  for (const open of opens) {
    const next = starts.find(
      (s) =>
        s.workspaceId === open.workspaceId &&
        s.at > open.at &&
        s.at - open.at < 3_600_000,
    );
    if (next) gaps.push((next.at - open.at) / 60_000);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

export interface InterruptionPattern {
  reason: string;
  count: number;
}

export function repeatedInterruptions(
  sessions: Session[],
  minCount = 2,
): InterruptionPattern[] {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    for (const i of s.interruptions) {
      const key = i.reason.trim().toLowerCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

/** Completions per hour-of-day (0-23). */
export function completionsByHour(events: ActivityEvent[]): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const e of events) {
    if (e.type === "task_completed" || e.type === "session_ended") {
      hours[new Date(e.at).getHours()]++;
    }
  }
  return hours;
}

export function carriedForwardTasks(tasks: Task[], min = 2): Task[] {
  return tasks
    .filter(
      (t) =>
        t.carriedOverCount >= min &&
        t.status !== "done" &&
        t.status !== "archived",
    )
    .sort((a, b) => b.carriedOverCount - a.carriedOverCount);
}

export interface RestoreStats {
  total: number;
  completed: number;
  partial: number;
  failedItems: number;
  topReasons: { reason: string; count: number }[];
}

export function restoreStats(runs: RestoreRun[]): RestoreStats {
  let completed = 0;
  let partial = 0;
  let failedItems = 0;
  const reasons = new Map<string, number>();
  for (const run of runs) {
    if (run.status === "completed") completed++;
    if (run.status === "partial") partial++;
    for (const item of run.items) {
      if (item.state === "failed" || item.state === "permission_required") {
        failedItems++;
        const r = item.reason ?? "unknown";
        reasons.set(r, (reasons.get(r) ?? 0) + 1);
      }
    }
  }
  return {
    total: runs.length,
    completed,
    partial,
    failedItems,
    topReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3),
  };
}
