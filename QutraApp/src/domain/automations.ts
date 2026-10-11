import type { Automation, AutomationRun, Workspace } from "./types";

/* ============================================================
   Automation engine: condition matching, rate limiting, dry run.
   Actions execute through explicit executors provided by the
   caller — the engine itself never touches the shell.
   ============================================================ */

export interface AutomationContext {
  workspace?: Workspace;
  branch?: string;
  tag?: string;
  taskStatus?: string;
  now?: number;
}

export function conditionsMatch(
  automation: Automation,
  ctx: AutomationContext,
): { ok: boolean; failed?: string } {
  const now = ctx.now ?? Date.now();
  for (const cond of automation.conditions) {
    switch (cond.field) {
      case "workspace":
        if (!ctx.workspace || ctx.workspace.id !== cond.value)
          return { ok: false, failed: "workspace" };
        break;
      case "tag":
        if (!ctx.workspace?.tags.includes(cond.value) && ctx.tag !== cond.value)
          return { ok: false, failed: "tag" };
        break;
      case "branch":
        if (ctx.branch !== cond.value) return { ok: false, failed: "branch" };
        break;
      case "status":
        if (ctx.taskStatus !== cond.value)
          return { ok: false, failed: "status" };
        break;
      case "day": {
        // value: comma-separated 0-6 (Sunday=0)
        const days = cond.value.split(",").map((d) => parseInt(d, 10));
        if (!days.includes(new Date(now).getDay()))
          return { ok: false, failed: "day" };
        break;
      }
      case "time_window": {
        // value: "HH:MM-HH:MM"
        const m = cond.value.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
        if (!m) return { ok: false, failed: "time_window" };
        const d = new Date(now);
        const cur = d.getHours() * 60 + d.getMinutes();
        const from = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        const to = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
        const inWindow =
          from <= to ? cur >= from && cur <= to : cur >= from || cur <= to;
        if (!inWindow) return { ok: false, failed: "time_window" };
        break;
      }
    }
  }
  return { ok: true };
}

export function isRateLimited(
  automation: Automation,
  recentRuns: AutomationRun[],
  nowMs: number = Date.now(),
): boolean {
  const hourAgo = nowMs - 3_600_000;
  const count = recentRuns.filter(
    (r) =>
      r.automationId === automation.id &&
      r.at >= hourAgo &&
      r.status !== "dry_run",
  ).length;
  return count >= automation.rateLimitPerHour;
}

/** Human-readable dry-run plan; never executes anything. */
export function dryRunPlan(automation: Automation): string[] {
  return automation.actions.map((action) => {
    const param = action.param ? ` → ${action.param}` : "";
    return `${action.type}${param}`;
  });
}

/** Permission surface used by an automation, for the visible summary. */
export function permissionSummary(automation: Automation): string[] {
  const perms = new Set<string>();
  for (const action of automation.actions) {
    switch (action.type) {
      case "open_resource":
        perms.add("file_access");
        break;
      case "run_command":
        perms.add("shell_allowlist");
        break;
      case "notify":
        perms.add("notifications");
        break;
      case "webhook":
        perms.add("network");
        break;
      case "capture_snapshot":
        perms.add("window_metadata");
        break;
      default:
        break;
    }
  }
  return [...perms];
}
