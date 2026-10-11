import { describe, expect, it } from "vitest";
import {
  conditionsMatch,
  dryRunPlan,
  isRateLimited,
  permissionSummary,
} from "./automations";
import type { Automation, AutomationRun, Workspace } from "./types";

const ws: Workspace = {
  id: "wsA",
  name: "A",
  color: "#000",
  icon: "folder",
  purpose: "",
  type: "software",
  status: "active",
  favorite: false,
  tags: ["react"],
  defaultCommands: [],
  environmentLabels: [],
  ignoredPaths: [],
  browserCollections: [],
  restoreBehavior: "ask",
  health: "ready",
  demo: false,
  createdAt: 0,
  updatedAt: 0,
  lastActivityAt: 0,
};

const automation = (over: Partial<Automation> = {}): Automation => ({
  id: "a1",
  name: "test",
  trigger: "session_ended",
  conditions: [],
  actions: [{ type: "notify", param: "hi" }],
  enabled: true,
  requiresConfirmation: false,
  rateLimitPerHour: 2,
  retryPolicy: "none",
  demo: false,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("conditionsMatch", () => {
  it("matches workspace, tag, branch and day conditions", () => {
    expect(
      conditionsMatch(
        automation({ conditions: [{ field: "workspace", value: "wsA" }] }),
        { workspace: ws },
      ).ok,
    ).toBe(true);
    expect(
      conditionsMatch(
        automation({ conditions: [{ field: "workspace", value: "wsB" }] }),
        { workspace: ws },
      ),
    ).toMatchObject({ ok: false, failed: "workspace" });
    expect(
      conditionsMatch(
        automation({ conditions: [{ field: "tag", value: "react" }] }),
        { workspace: ws },
      ).ok,
    ).toBe(true);
    expect(
      conditionsMatch(
        automation({ conditions: [{ field: "branch", value: "main" }] }),
        { workspace: ws, branch: "dev" },
      ).ok,
    ).toBe(false);

    const monday = new Date("2026-07-20T10:00:00").getTime(); // Monday
    expect(
      conditionsMatch(
        automation({ conditions: [{ field: "day", value: "1" }] }),
        { now: monday },
      ).ok,
    ).toBe(true);
  });

  it("evaluates time windows including overnight ranges", () => {
    const at = (h: number) => new Date(2026, 6, 20, h, 0, 0).getTime();
    const auto = automation({
      conditions: [{ field: "time_window", value: "09:00-17:00" }],
    });
    expect(conditionsMatch(auto, { now: at(10) }).ok).toBe(true);
    expect(conditionsMatch(auto, { now: at(20) }).ok).toBe(false);

    const overnight = automation({
      conditions: [{ field: "time_window", value: "22:00-06:00" }],
    });
    expect(conditionsMatch(overnight, { now: at(23) }).ok).toBe(true);
    expect(conditionsMatch(overnight, { now: at(3) }).ok).toBe(true);
    expect(conditionsMatch(overnight, { now: at(12) }).ok).toBe(false);
  });
});

describe("isRateLimited", () => {
  const run = (minutesAgo: number, status: AutomationRun["status"] = "success"): AutomationRun => ({
    id: `r${minutesAgo}`,
    automationId: "a1",
    at: Date.now() - minutesAgo * 60_000,
    status,
    detail: "",
    demo: false,
  });

  it("limits by executions in the last hour, ignoring dry runs", () => {
    const auto = automation({ rateLimitPerHour: 2 });
    expect(isRateLimited(auto, [run(10), run(20)])).toBe(true);
    expect(isRateLimited(auto, [run(10), run(90)])).toBe(false);
    expect(isRateLimited(auto, [run(10), run(20, "dry_run")])).toBe(false);
  });
});

describe("dryRunPlan / permissionSummary", () => {
  it("describes actions without executing and lists permission surface", () => {
    const auto = automation({
      actions: [
        { type: "notify", param: "msg" },
        { type: "run_command", param: "npm test" },
        { type: "open_resource", param: "res1" },
      ],
    });
    expect(dryRunPlan(auto)).toEqual([
      "notify → msg",
      "run_command → npm test",
      "open_resource → res1",
    ]);
    const perms = permissionSummary(auto);
    expect(perms).toContain("notifications");
    expect(perms).toContain("shell_allowlist");
    expect(perms).toContain("file_access");
  });
});
