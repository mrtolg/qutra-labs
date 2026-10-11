import { describe, expect, it } from "vitest";
import { Database } from "./database";
import { MemoryStorageAdapter } from "./storage";
import {
  runMigrations,
  CURRENT_SCHEMA_VERSION,
  RETIRED_ARCHIVE_KEY,
  RETIRED_COLLECTIONS,
} from "./migrations";
import { loadDemoData, isSeeded } from "@/domain/seed";
import { collectionSchemas, type CollectionName } from "@/domain/types";

const freshDb = () => new Database(new MemoryStorageAdapter());

describe("Database collections", () => {
  it("validates records with zod at the boundary and persists them", () => {
    const db = freshDb();
    const col = db.collection("tasks");
    col.put({
      id: "t1",
      title: "Test task",
      description: "",
      status: "todo",
      priority: "none",
      tags: [],
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: false,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(col.get("t1")?.title).toBe("Test task");
    expect(() =>
      col.put({ id: "bad" } as never),
    ).toThrow(); // schema violation rejected
  });

  it("keeps invalid rows aside on load, so a later write cannot erase them", () => {
    const storage = new MemoryStorageAdapter();
    storage.write(
      "tasks",
      JSON.stringify([
        { id: "ok", title: "x", status: "todo", createdAt: 1, updatedAt: 1 },
        { totally: "broken" },
      ]),
    );
    const db = new Database(storage);
    const rows = db.collection("tasks").getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("ok");
    // The next write replaces the collection; the broken row is still kept
    // (as the boot migrations left it: they add task defaults to every row).
    db.collection("tasks").patch("ok", { title: "y" });
    expect(db.quarantined()).toEqual([
      expect.objectContaining({
        collection: "tasks",
        reason: "invalid_record",
        value: expect.objectContaining({ totally: "broken" }),
      }),
    ]);
  });

  it("keeps a collection whose text is not JSON instead of emptying it", () => {
    const storage = new MemoryStorageAdapter();
    storage.write("tasks", "[{oops");
    const db = new Database(storage);
    expect(db.collection("tasks").getAll()).toEqual([]);
    expect(db.quarantined()).toEqual([
      expect.objectContaining({
        collection: "tasks",
        reason: "unreadable_collection",
        value: "[{oops",
      }),
    ]);
  });

  it("counts what it kept aside even in collections nothing has opened yet", () => {
    const storage = new MemoryStorageAdapter();
    storage.write("evidence", JSON.stringify([{ totally: "broken" }]));
    expect(new Database(storage).quarantined()).toHaveLength(1);
  });

  it("reads today's shapes of every collection without setting any aside", () => {
    const storage = new MemoryStorageAdapter();
    loadDemoData(new Database(storage));
    const copy = new MemoryStorageAdapter();
    for (const key of storage.keys()) copy.write(key, storage.read(key)!);
    const db = new Database(copy);
    for (const name of Object.keys(collectionSchemas) as CollectionName[]) {
      const stored = JSON.parse(storage.read(name) ?? "[]") as unknown[];
      expect(db.collection(name).getAll(), name).toHaveLength(stored.length);
    }
    expect(db.quarantined()).toEqual([]);
  });

  it("exports the records kept aside with the data", () => {
    const storage = new MemoryStorageAdapter();
    storage.write("tasks", JSON.stringify([{ totally: "broken" }]));
    const exported = JSON.parse(new Database(storage).exportAll()) as { quarantine?: unknown[] };
    expect(exported.quarantine).toHaveLength(1);
  });

  it("patch and removeWhere behave as expected", () => {
    const db = freshDb();
    const col = db.collection("tasks");
    col.put({
      id: "i1",
      title: "hello",
      description: "",
      status: "todo",
      priority: "none",
      tags: [],
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: true,
      createdAt: 1,
      updatedAt: 1,
    });
    col.patch("i1", { status: "archived" });
    expect(col.get("i1")?.status).toBe("archived");
    expect(col.removeWhere((r) => r.demo)).toBe(1);
    expect(col.getAll()).toHaveLength(0);
  });
});

describe("migrations", () => {
  it("upgrades from version 0 and backfills carriedOverCount", () => {
    const storage = new MemoryStorageAdapter();
    storage.write(
      "tasks",
      JSON.stringify([
        { id: "legacy", title: "old", status: "todo", createdAt: 1, updatedAt: 1 },
      ]),
    );
    const result = runMigrations(storage);
    expect(result.from).toBe(0);
    expect(result.to).toBe(CURRENT_SCHEMA_VERSION);
    const rows = JSON.parse(storage.read("tasks")!) as { carriedOverCount?: number }[];
    expect(rows[0].carriedOverCount).toBe(0);
    // idempotent
    const again = runMigrations(storage);
    expect(again.from).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("normalizes legacy evidence links and recovers structural run ids", () => {
    const storage = new MemoryStorageAdapter();
    storage.write("meta", JSON.stringify({ schemaVersion: 7 }));
    storage.write(
      "findings",
      JSON.stringify([
        { id: "f-1", evidenceIds: ["ev-1", "stale"] },
        { id: "f-2", evidenceIds: ["ev-1", "ev-2"] },
      ]),
    );
    storage.write(
      "evidence",
      JSON.stringify([
        { id: "ev-1", findingId: "f-2", source: "run:run-1 (stdout)" },
        { id: "ev-2", source: "manual" },
        { id: "ev-3", findingId: "missing", source: "run:run-3" },
      ]),
    );

    runMigrations(storage);
    const findings = JSON.parse(storage.read("findings")!) as {
      id: string;
      evidenceIds: string[];
    }[];
    const evidence = JSON.parse(storage.read("evidence")!) as {
      id: string;
      findingId?: string;
      runId?: string;
    }[];

    expect(findings.find((item) => item.id === "f-1")?.evidenceIds).toEqual([]);
    expect(findings.find((item) => item.id === "f-2")?.evidenceIds).toEqual([
      "ev-1",
      "ev-2",
    ]);
    expect(evidence.find((item) => item.id === "ev-1")).toMatchObject({
      findingId: "f-2",
      runId: "run-1",
    });
    expect(evidence.find((item) => item.id === "ev-3")?.findingId)
      .toBeUndefined();
  });

  it("keeps a fresh install empty at the current schema", () => {
    const storage = new MemoryStorageAdapter();
    const result = runMigrations(storage);
    expect(result).toEqual({ from: 0, to: CURRENT_SCHEMA_VERSION });
    expect(storage.read("conversations")).toBeNull();
    expect(storage.read(RETIRED_ARCHIVE_KEY)).toBeNull();
    for (const name of RETIRED_COLLECTIONS) {
      expect(storage.read(name)).toBeNull();
    }
  });

  it("archives retired v0.1.0 data, redacts secrets and normalizes layout", () => {
    const storage = new MemoryStorageAdapter();
    storage.write("meta", JSON.stringify({ schemaVersion: 11 }));
    storage.write(
      "notes",
      JSON.stringify([
        {
          id: "n1",
          title: "Legacy",
          body: "token=ghp_abcdefghijklmnopqrstuvwxyz123456",
        },
      ]),
    );
    storage.write(
      "clipboard",
      JSON.stringify([{ id: "c1", content: "sk-abcdefghijklmnopqrstuv" }]),
    );
    storage.write(
      "preferences",
      JSON.stringify({
        locale: "tr",
        workbenchMode: "knowledge",
        workbenchModeRoutes: { knowledge: "/notes" },
        workbenchTabs: [
          { route: "/notes", pinned: true, openedAt: 1 },
          { route: "/lab?view=runs", pinned: false, openedAt: 2 },
        ],
        workbenchRecentlyClosed: ["/clipboard", "/files"],
        clipboardEnabled: true,
        labAcademyProgress: { intro: "completed" },
      }),
    );
    storage.write(
      "snapshots",
      JSON.stringify([
        {
          id: "s1",
          items: [
            { id: "i1", kind: "note" },
            { id: "i2", kind: "file" },
          ],
        },
      ]),
    );

    runMigrations(storage);

    const archive = JSON.parse(storage.read(RETIRED_ARCHIVE_KEY)!);
    expect(archive.version).toBe(12);
    expect(JSON.stringify(archive)).not.toContain("ghp_");
    expect(JSON.stringify(archive)).not.toContain("sk-");
    expect(archive.collections.notes).toHaveLength(1);
    expect(archive.preferences.clipboardEnabled).toBe(true);
    expect(storage.read("notes")).toBeNull();
    expect(storage.read("clipboard")).toBeNull();

    const preferences = JSON.parse(storage.read("preferences")!);
    expect(preferences.workbenchMode).toBe("core");
    expect(preferences.workbenchModeRoutes).toEqual({});
    expect(preferences.workbenchTabs.map((tab: { route: string }) => tab.route))
      .toEqual(["/lab?view=runs"]);
    expect(preferences.workbenchRecentlyClosed).toEqual(["/files"]);
    expect(preferences.clipboardEnabled).toBeUndefined();
    expect(preferences.labAcademyProgress).toBeUndefined();

    const snapshots = JSON.parse(storage.read("snapshots")!);
    expect(snapshots[0].items.map((item: { kind: string }) => item.kind))
      .toEqual(["file"]);
  });

  it("runs the retirement migration idempotently", () => {
    const storage = new MemoryStorageAdapter();
    storage.write("meta", JSON.stringify({ schemaVersion: 11 }));
    storage.write("inbox", JSON.stringify([{ id: "legacy", text: "keep" }]));
    runMigrations(storage);
    const firstArchive = storage.read(RETIRED_ARCHIVE_KEY);
    runMigrations(storage);
    expect(storage.read(RETIRED_ARCHIVE_KEY)).toBe(firstArchive);
    expect(storage.read("inbox")).toBeNull();
  });

  it("moves a stored contextos pack to hud once and leaves catppuccin", () => {
    const contextos = new MemoryStorageAdapter();
    contextos.write("meta", JSON.stringify({ schemaVersion: 12 }));
    contextos.write("preferences", JSON.stringify({ packId: "contextos", locale: "en" }));
    runMigrations(contextos);
    expect(JSON.parse(contextos.read("preferences")!).packId).toBe("hud");
    expect(JSON.parse(contextos.read("preferences")!).locale).toBe("en");
    runMigrations(contextos);
    expect(JSON.parse(contextos.read("preferences")!).packId).toBe("hud");

    const catppuccin = new MemoryStorageAdapter();
    catppuccin.write("meta", JSON.stringify({ schemaVersion: 12 }));
    catppuccin.write("preferences", JSON.stringify({ packId: "catppuccin" }));
    runMigrations(catppuccin);
    expect(JSON.parse(catppuccin.read("preferences")!).packId).toBe("catppuccin");
    runMigrations(catppuccin);
    expect(JSON.parse(catppuccin.read("preferences")!).packId).toBe("catppuccin");
  });
});

describe("demo data lifecycle", () => {
  it("loads a marked demo dataset and removes it completely", () => {
    const db = freshDb();
    expect(isSeeded(db)).toBe(false);
    loadDemoData(db);
    expect(isSeeded(db)).toBe(true);
    expect(db.collection("workspaces").getAll().length).toBeGreaterThanOrEqual(3);
    expect(db.collection("events").getAll().length).toBeGreaterThan(30);

    // user-created data must survive demo removal
    db.collection("tasks").put({
      id: "mine",
      title: "Kept",
      description: "",
      status: "todo",
      priority: "none",
      tags: [],
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: false,
      createdAt: 1,
      updatedAt: 1,
    });
    const removed = db.removeDemoData();
    expect(removed).toBeGreaterThan(50);
    expect(isSeeded(db)).toBe(false);
    expect(db.collection("tasks").get("mine")).toBeDefined();
    expect(db.collection("workspaces").getAll()).toHaveLength(0);
  });
});

describe("export / import", () => {
  it("round-trips a schema-versioned export", async () => {
    const db = freshDb();
    loadDemoData(db);
    const json = db.exportAll();
    const parsed = JSON.parse(json);
    expect(parsed.app).toBe("contextos");
    expect(parsed.schemaVersion).toBeDefined();

    const db2 = freshDb();
    const result = await db2.importAll(json);
    expect(result.ok).toBe(true);
    expect(result.imported).toBeGreaterThan(50);
    expect(db2.collection("workspaces").getAll().length).toBe(
      db.collection("workspaces").getAll().length,
    );
  });

  it("never brings an investigation's cloud allowance with an import", async () => {
    const db = freshDb();
    db.collection("engagements").put({
      id: "eng-1",
      title: "Home Lab",
      purpose: "training_lab",
      status: "active",
      clientLabel: "",
      contacts: [],
      notes: "",
      tags: [],
      demo: false,
      cloudConsent: { provider: "anthropic", host: "api.anthropic.com", grantedAt: 5 },
      createdAt: 1,
      updatedAt: 1,
    });
    const db2 = freshDb();
    expect((await db2.importAll(db.exportAll())).ok).toBe(true);
    const imported = db2.collection("engagements").get("eng-1");
    expect(imported?.title).toBe("Home Lab");
    expect(imported).not.toHaveProperty("cloudConsent");
  });

  it("restores preferences from a full export", async () => {
    const db = freshDb();
    db.prefs.set({ activityTrackingEnabled: true, locale: "tr" });
    const json = db.exportAll();
    const db2 = freshDb();
    expect(db2.prefs.get().activityTrackingEnabled).toBe(false);
    const result = await db2.importAll(json);
    expect(result.ok).toBe(true);
    expect(db2.prefs.get().activityTrackingEnabled).toBe(true);
    expect(db2.prefs.get().locale).toBe("tr");
  });

  it("does not copy an agent-enabled preference or confirmation marker on import", async () => {
    const source = freshDb();
    source.prefs.set({
      localAssistantEnabled: true,
      privateToolsEnabled: true,
      assistantAgentToolsEnabled: true,
      assistantAgentConsentEpoch: 1,
      assistantAgentAwaitingConfirmation: false,
    });
    const target = freshDb();
    const result = await target.importAll(source.exportAll());
    expect(result.ok).toBe(true);
    const prefs = target.prefs.get();
    expect(prefs.localAssistantEnabled).toBe(true);
    expect(prefs.privateToolsEnabled).toBe(true);
    expect(prefs.assistantAgentToolsEnabled).toBe(false);
    expect(prefs.assistantAgentAwaitingConfirmation).toBe(true);
  });

  it("migrates a stored G=true with no epoch to awaiting confirmation", () => {
    const storage = new MemoryStorageAdapter();
    storage.write(
      "preferences",
      JSON.stringify({
        localAssistantEnabled: true,
        privateToolsEnabled: true,
        assistantAgentToolsEnabled: true,
      }),
    );
    const db = new Database(storage);
    const prefs = db.prefs.get();
    expect(prefs.localAssistantEnabled).toBe(true);
    expect(prefs.privateToolsEnabled).toBe(true);
    expect(prefs.assistantAgentToolsEnabled).toBe(false);
    expect(prefs.assistantAgentAwaitingConfirmation).toBe(true);
  });


  it("replaces the complete dataset by default and removes excess rows", async () => {
    const source = freshDb();
    source.collection("tasks").put({
      id: "from-backup",
      title: "Backup task",
      description: "",
      status: "todo",
      priority: "none",
      tags: [],
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: false,
      createdAt: 1,
      updatedAt: 1,
    });

    const target = freshDb();
    target.collection("tasks").put({
      id: "local-extra",
      title: "Must be removed by restore",
      description: "",
      status: "todo",
      priority: "none",
      tags: [],
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: false,
      createdAt: 2,
      updatedAt: 2,
    });

    const result = await target.importAll(source.exportAll());
    expect(result).toMatchObject({ ok: true, mode: "replace" });
    expect(target.collection("tasks").getAll().map((task) => task.id)).toEqual([
      "from-backup",
    ]);
  });

  it("offers an explicit merge mode that preserves unrelated rows", async () => {
    const source = freshDb();
    source.collection("tasks").put({
      id: "from-backup",
      title: "Backup task",
      description: "",
      status: "todo",
      priority: "none",
      tags: [],
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: false,
      createdAt: 1,
      updatedAt: 1,
    });
    const target = freshDb();
    target.collection("tasks").put({
      id: "local-extra",
      title: "Preserved",
      description: "",
      status: "todo",
      priority: "none",
      tags: [],
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: false,
      createdAt: 2,
      updatedAt: 2,
    });

    const result = await target.importAll(source.exportAll(), { mode: "merge" });
    expect(result).toMatchObject({ ok: true, mode: "merge" });
    expect(
      target.collection("tasks").getAll().map((task) => task.id).sort(),
    ).toEqual(["from-backup", "local-extra"]);
  });

  it("validates the whole backup before changing any collection", async () => {
    const db = freshDb();
    db.collection("tasks").put({
      id: "kept",
      title: "Still here",
      description: "",
      status: "todo",
      priority: "none",
      tags: [],
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: false,
      createdAt: 1,
      updatedAt: 1,
    });
    const payload = JSON.parse(db.exportAll());
    payload.data.tasks = [{ id: "invalid" }];

    const result = await db.importAll(JSON.stringify(payload));
    expect(result).toMatchObject({
      ok: false,
      imported: 0,
      error: "invalid_collection:tasks",
    });
    expect(db.collection("tasks").getAll().map((task) => task.id)).toEqual([
      "kept",
    ]);
  });

  it("does not publish a restore when the durable transaction fails", async () => {
    const adapter = new MemoryStorageAdapter();
    const db = new Database(adapter);
    db.collection("tasks").put({
      id: "kept",
      title: "Still here",
      description: "",
      status: "todo",
      priority: "none",
      tags: [],
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: false,
      createdAt: 1,
      updatedAt: 1,
    });
    const source = freshDb();
    adapter.writeBatchDurable = async () => {
      throw new Error("disk_full");
    };

    const result = await db.importAll(source.exportAll());
    expect(result).toMatchObject({
      ok: false,
      imported: 0,
      error: "persistence_error",
    });
    expect(db.collection("tasks").getAll().map((task) => task.id)).toEqual([
      "kept",
    ]);
  });

  it("rejects unrecognized payloads without corrupting data", async () => {
    const db = freshDb();
    expect((await db.importAll("not json")).ok).toBe(false);
    expect((await db.importAll(JSON.stringify({ app: "other" }))).ok).toBe(false);
  });

  it("setDurable rejects when flush fails", async () => {
    const adapter = new MemoryStorageAdapter();
    let fail = false;
    adapter.flush = async () => {
      if (fail) throw new Error("disk_full");
    };
    const db = new Database(adapter);
    fail = true;
    await expect(db.prefs.setDurable({ locale: "tr" })).rejects.toThrow(/disk_full/);
    expect(db.prefs.get().locale).not.toBe("tr");
  });

  it("concurrent setDurable calls touching different fields both survive", async () => {
    const adapter = new MemoryStorageAdapter();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.flush = () => held;
    const db = new Database(adapter);

    const localeWrite = db.prefs.setDurable({ locale: "tr" });
    const themeWrite = db.prefs.setDurable({ theme: "dark" });
    release();
    await Promise.all([localeWrite, themeWrite]);

    const prefs = db.prefs.get();
    expect(prefs.locale).toBe("tr");
    expect(prefs.theme).toBe("dark");
    const stored = JSON.parse(adapter.read("preferences") ?? "{}") as {
      locale?: string;
      theme?: string;
    };
    expect(stored.locale).toBe("tr");
    expect(stored.theme).toBe("dark");
  });

  it("concurrent putDurable calls for different records both survive", async () => {
    const adapter = new MemoryStorageAdapter();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.flush = () => held;
    const db = new Database(adapter);
    const tasks = db.collection("tasks");
    const row = (id: string, title: string) => ({
      id,
      title,
      description: "",
      status: "todo" as const,
      priority: "none" as const,
      tags: [],
      blockedByIds: [],
      recurrence: "none" as const,
      carriedOverCount: 0,
      demo: false,
      createdAt: 1,
      updatedAt: 1,
    });

    const first = tasks.putDurable(row("task-a", "Alpha"));
    const second = tasks.putDurable(row("task-b", "Beta"));
    release();
    await Promise.all([first, second]);

    expect(tasks.getAll().map((task) => task.id).sort()).toEqual([
      "task-a",
      "task-b",
    ]);
  });

  it("putDurable publishes only after the adapter commits", async () => {
    const adapter = new MemoryStorageAdapter();
    const db = new Database(adapter);
    adapter.writeBatchDurable = async () => {
      throw new Error("disk_full");
    };

    await expect(
      db.collection("tasks").putDurable({
        id: "not-published",
        title: "No false success",
        description: "",
        status: "todo",
        priority: "none",
        tags: [],
        blockedByIds: [],
        recurrence: "none",
        carriedOverCount: 0,
        demo: false,
        createdAt: 1,
        updatedAt: 1,
      }),
    ).rejects.toThrow(/disk_full/);
    expect(db.collection("tasks").getAll()).toEqual([]);
  });
});

describe("complete deletion", () => {
  it("deleteEverything wipes storage and collections", async () => {
    const db = freshDb();
    loadDemoData(db);
    await db.deleteEverything();
    expect(db.collection("workspaces").getAll()).toHaveLength(0);
    expect(db.estimateSizeBytes()).toBe(0);
  });
});
