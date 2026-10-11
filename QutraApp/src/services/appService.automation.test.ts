import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserBridge } from "@/lib/bridge/browserBridge";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
} from "@/lib/bridge";
import {
  Database,
  setDbForTesting,
} from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import type { Automation } from "@/domain/types";
import { buildCaptureCandidates, executeAutomation } from "./appService";

function automation(
  actions: Automation["actions"],
  changes: Partial<Automation> = {},
): Automation {
  return {
    id: "automation-1",
    name: "Verified automation",
    trigger: "manual",
    conditions: [],
    actions,
    enabled: true,
    requiresConfirmation: false,
    rateLimitPerHour: 12,
    retryPolicy: "none",
    demo: false,
    createdAt: 1,
    updatedAt: 1,
    ...changes,
  };
}

function setup(value: Automation) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ activityTrackingEnabled: true });
  db.collection("automations").put(value);
  setDbForTesting(db);
  const bridge = new BrowserBridge();
  setBridgeForTesting(bridge);
  return { db, bridge };
}

afterEach(() => {
  setDbForTesting(null);
  resetBridgeForTesting();
  vi.restoreAllMocks();
});

describe("automation execution truthfulness", () => {
  it("awaits a native notification result before recording success", async () => {
    const value = automation([{ type: "notify", param: "Finished" }]);
    const { db, bridge } = setup(value);
    let release!: () => void;
    vi.spyOn(bridge, "notify").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, simulated: false });
        }),
    );

    const pending = executeAutomation(value);
    expect(db.collection("automationRuns").getAll()).toEqual([]);
    release();
    const execution = await pending;

    expect(execution.status).toBe("success");
    expect(execution.actions).toEqual([
      { type: "notify", status: "succeeded", detail: "Finished" },
    ]);
    expect(db.collection("automationRuns").getAll()[0]?.status).toBe("success");
  });

  it("records browser simulation as blocked instead of successful", async () => {
    const value = automation([{ type: "notify", param: "Finished" }]);
    const { db } = setup(value);

    const execution = await executeAutomation(value);

    expect(execution).toMatchObject({ ok: false, status: "blocked" });
    expect(execution.actions[0]).toMatchObject({
      type: "notify",
      status: "blocked",
      detail: "browser_mode",
    });
    expect(db.collection("automationRuns").getAll()[0]?.status).toBe("blocked");
  });

  it("reports a mixed real and unavailable action set as partial", async () => {
    const value = automation([
      { type: "create_task", param: "Review findings" },
      { type: "run_command", param: "echo unsafe-to-fake" },
    ]);
    const { db } = setup(value);

    const execution = await executeAutomation(value);

    expect(execution.status).toBe("partial");
    expect(execution.actions.map((action) => action.status)).toEqual([
      "succeeded",
      "blocked",
    ]);
    expect(db.collection("tasks").getAll()[0]?.title).toBe("Review findings");
  });

  it("blocks confirmation-required automations until explicitly confirmed", async () => {
    const value = automation(
      [{ type: "create_task", param: "Must not run" }],
      { requiresConfirmation: true },
    );
    const { db } = setup(value);

    const execution = await executeAutomation(value);

    expect(execution.status).toBe("blocked");
    expect(execution.actions[0]?.detail).toBe("confirmation_required");
    expect(db.collection("tasks").getAll()).toEqual([]);
  });
});

describe("snapshot candidate provenance", () => {
  it("keeps browser fixtures unselected and identifies saved resources", async () => {
    const db = new Database(new MemoryStorageAdapter());
    setDbForTesting(db);
    setBridgeForTesting(new BrowserBridge());
    db.collection("resources").put({
      id: "resource-1",
      kind: "url",
      title: "GitHub",
      target: "https://github.com/example/project",
      workspaceId: "workspace-1",
      tags: [],
      demo: false,
      createdAt: 1,
    });

    const { candidates } = await buildCaptureCandidates("workspace-1");
    const apps = candidates.filter((item) => item.kind === "app");
    const savedTab = candidates.find((item) => item.kind === "browser_tab");

    expect(apps.length).toBeGreaterThan(0);
    expect(apps.every((item) => !item.selected)).toBe(true);
    expect(apps.every((item) => item.provenance === "simulated")).toBe(true);
    expect(savedTab).toMatchObject({
      selected: true,
      provenance: "saved_resource",
    });
  });
});
