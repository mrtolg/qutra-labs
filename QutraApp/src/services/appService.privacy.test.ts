import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { recordEvent } from "@/services/appService";

function fresh(): Database {
  return new Database(new MemoryStorageAdapter());
}

beforeEach(() => {
  setDbForTesting(fresh());
});

afterEach(() => {
  setDbForTesting(null);
});

describe("recordEvent privacy gate", () => {
  it("does not persist activity events or fire automations when tracking is off", () => {
    const db = getDb();
    db.prefs.set({ activityTrackingEnabled: false });
    db.collection("automations").put({
      id: "auto1",
      name: "Open workspace",
      enabled: true,
      trigger: "workspace_opened",
      conditions: [],
      actions: [{ type: "create_task", param: "From auto" }],
      requiresConfirmation: false,
      rateLimitPerHour: 12,
      retryPolicy: "none",
      demo: false,
      createdAt: 1,
      updatedAt: 1,
    });

    const beforeTasks = db.collection("tasks").getAll().length;
    const beforeEvents = db.collection("events").getAll().length;

    const result = recordEvent("workspace_opened", "Should not land", {
      workspaceId: "ws1",
    });

    expect(result).toBeUndefined();
    expect(db.collection("events").getAll()).toHaveLength(beforeEvents);
    expect(db.collection("tasks").getAll()).toHaveLength(beforeTasks);
    expect(db.collection("automationRuns").getAll()).toHaveLength(0);
  });

  it("persists events when tracking is on", () => {
    const db = getDb();
    db.prefs.set({ activityTrackingEnabled: true });
    const event = recordEvent("workspace_opened", "Lab desk", {
      workspaceId: "ws1",
    });
    expect(event).toBeDefined();
    expect(event!.type).toBe("workspace_opened");
    expect(db.collection("events").getAll().some((e) => e.id === event!.id)).toBe(
      true,
    );
  });

  it("allows privacy audit events even when tracking is off", () => {
    const db = getDb();
    db.prefs.set({ activityTrackingEnabled: false });
    const paused = recordEvent("privacy_paused", "Activity tracking disabled");
    expect(paused).toBeDefined();
    expect(db.collection("events").getAll()).toHaveLength(1);
  });
});

describe("import restores preferences", () => {
  it("round-trips preferences from exportAll", async () => {
    const db = fresh();
    db.prefs.set({
      activityTrackingEnabled: true,
      locale: "tr",
      theme: "highContrast",
    });
    const json = db.exportAll();

    const db2 = fresh();
    expect(db2.prefs.get().activityTrackingEnabled).toBe(false);
    const result = await db2.importAll(json);
    expect(result.ok).toBe(true);
    expect(db2.prefs.get().activityTrackingEnabled).toBe(true);
    expect(db2.prefs.get().locale).toBe("tr");
    expect(db2.prefs.get().theme).toBe("highContrast");
  });
});
