import { describe, expect, it } from "vitest";
import { Database } from "./database";
import { CURRENT_SCHEMA_VERSION, runMigrations } from "./migrations";
import { MemoryStorageAdapter, type StorageAdapter } from "./storage";

/* Conversation migration (data contracts §3 "Migration and lifecycle"): the single
   pre-conversation transcript moves into one conversation, and the migration marker
   and the retirement of the legacy field commit together. */

const LEGACY = [
  { role: "user", content: "what listens on 10.0.0.5?" },
  {
    role: "assistant",
    content: "Port 22.",
    answeredBy: { endpoint: "http://127.0.0.1:11435", model: "qwen2.5:14b" },
  },
];

function v13Store(history: unknown = LEGACY): MemoryStorageAdapter {
  const storage = new MemoryStorageAdapter();
  storage.write("meta", JSON.stringify({ schemaVersion: 13 }));
  storage.write(
    "preferences",
    JSON.stringify({ locale: "tr", localAssistantHistory: history }),
  );
  return storage;
}

const read = (storage: StorageAdapter, key: string) =>
  JSON.parse(storage.read(key) ?? "null") as unknown;

type Changes = Record<string, string | null>;

/**
 * The SQLite adapter's shape: a synchronous view in front of a disk, and an
 * ordered queue of transactions between them (one per write, one per
 * batch). `commit()` drains the queue; `crash()` boots a new adapter from
 * the disk alone, like a power cut with transactions still queued.
 */
class CrashableAdapter implements StorageAdapter {
  private view: Map<string, string>;
  private queue: { changes: Changes; batch: boolean }[] = [];
  constructor(private readonly disk: Map<string, string>) {
    this.view = new Map(disk);
  }
  private apply(target: Map<string, string>, changes: Changes) {
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) target.delete(key);
      else target.set(key, value);
    }
  }
  read(key: string) {
    return this.view.get(key) ?? null;
  }
  write(key: string, value: string) {
    this.apply(this.view, { [key]: value });
    this.queue.push({ changes: { [key]: value }, batch: false });
  }
  remove(key: string) {
    this.apply(this.view, { [key]: null });
    this.queue.push({ changes: { [key]: null }, batch: false });
  }
  keys() {
    return [...this.view.keys()];
  }
  estimateSizeBytes() {
    return 0;
  }
  writeBatch(changes: Readonly<Changes>) {
    this.apply(this.view, { ...changes });
    this.queue.push({ changes: { ...changes }, batch: true });
  }
  async writeBatchDurable(changes: Readonly<Changes>): Promise<boolean> {
    this.writeBatch(changes);
    this.commit();
    return true;
  }
  /** Drain the queue; with `failBatches`, every batch rolls back. */
  commit({ failBatches = false } = {}) {
    for (const { changes, batch } of this.queue) {
      if (!(batch && failBatches)) this.apply(this.disk, changes);
    }
    this.queue = [];
  }
  crash(): CrashableAdapter {
    return new CrashableAdapter(this.disk);
  }
}

function v13Disk(): CrashableAdapter {
  const disk = new Map<string, string>();
  disk.set("meta", JSON.stringify({ schemaVersion: 13 }));
  disk.set("preferences", JSON.stringify({ localAssistantHistory: LEGACY }));
  return new CrashableAdapter(disk);
}

describe("migration v14: the single transcript becomes a conversation", () => {
  it("moves a non-empty history into one unbound conversation", () => {
    const storage = v13Store();
    runMigrations(storage);

    const conversations = read(storage, "conversations") as {
      origin: string;
      title: string;
      workspaceId: null;
      engagementId: null;
      messages: { role: string; content: string; createdAt: null; answeredBy?: unknown }[];
    }[];
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      origin: "legacyHistory",
      title: "what listens on 10.0.0.5?",
      workspaceId: null,
      engagementId: null,
    });
    expect(conversations[0]?.messages.map((m) => [m.role, m.content, m.createdAt])).toEqual([
      ["user", "what listens on 10.0.0.5?", null],
      ["assistant", "Port 22.", null],
    ]);

    const prefs = read(storage, "preferences") as Record<string, unknown>;
    expect(prefs).not.toHaveProperty("localAssistantHistory");
    expect(prefs.locale).toBe("tr");
    expect((read(storage, "meta") as { schemaVersion: number }).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
  });

  it("commits the conversation, the retired field and the marker as one batch", () => {
    const storage = v13Store();
    const batches: string[][] = [];
    const original = storage.writeBatch.bind(storage);
    storage.writeBatch = (changes) => {
      batches.push(Object.keys(changes).sort());
      original(changes);
    };

    runMigrations(storage);

    expect(batches).toEqual([["conversations", "meta", "preferences"]]);
  });

  it("creates no conversation from an empty or previously erased history", () => {
    const storage = v13Store([]);
    runMigrations(storage);

    expect(read(storage, "conversations")).toBeNull();
    expect(read(storage, "preferences")).not.toHaveProperty("localAssistantHistory");
  });

  it("adds to conversations that already exist instead of replacing them", () => {
    const storage = v13Store();
    storage.write(
      "conversations",
      JSON.stringify([{ id: "conv_existing", title: "kept" }]),
    );
    runMigrations(storage);

    const ids = (read(storage, "conversations") as { id: string }[]).map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe("conv_existing");
  });

  it("does not run twice", () => {
    const storage = v13Store();
    runMigrations(storage);
    runMigrations(storage);
    expect(read(storage, "conversations")).toHaveLength(1);
  });

  it("leaves unreadable preferences alone", () => {
    const storage = new MemoryStorageAdapter();
    storage.write("meta", JSON.stringify({ schemaVersion: 13 }));
    storage.write("preferences", "{not json");
    expect(() => runMigrations(storage)).not.toThrow();
    expect(storage.read("preferences")).toBe("{not json");
    expect(read(storage, "conversations")).toBeNull();
  });

  it("a restart before the batch commits migrates again, once", () => {
    const first = v13Disk();
    runMigrations(first);
    // Power cut: nothing queued reached the disk.
    const second = first.crash();
    expect(read(second, "preferences")).toHaveProperty("localAssistantHistory");
    expect(read(second, "conversations")).toBeNull();

    runMigrations(second);
    second.commit();
    const third = second.crash();
    expect(read(third, "conversations")).toHaveLength(1);
    expect(read(third, "preferences")).not.toHaveProperty("localAssistantHistory");

    runMigrations(third);
    third.commit();
    expect(read(third.crash(), "conversations")).toHaveLength(1);
  });

  /* runMigrations writes the version marker again after the last migration,
     in its own transaction. If the batch rolls back and that write commits,
     the disk says v14 while the transcript is still in preferences; the
     next boot must still move it, not skip it by version. */
  it("a batch that rolled back is retried on the next boot even at v14", () => {
    const first = v13Disk();
    runMigrations(first);
    first.commit({ failBatches: true });

    const second = first.crash();
    expect((read(second, "meta") as { schemaVersion: number }).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(read(second, "preferences")).toHaveProperty("localAssistantHistory");

    runMigrations(second);
    second.commit();
    const third = second.crash();
    expect(read(third, "conversations")).toHaveLength(1);
    expect(read(third, "preferences")).not.toHaveProperty("localAssistantHistory");
  });

  it("the store boots with the migrated conversation", () => {
    const db = new Database(v13Store());
    const conversations = db.collection("conversations").getAll();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.messages[1]?.answeredBy).toEqual({
      endpoint: "http://127.0.0.1:11435",
      model: "qwen2.5:14b",
    });
    expect(db.prefs.get()).not.toHaveProperty("localAssistantHistory");
  });
});

describe("import of an export written before conversations existed", () => {
  const oldExport = (history: unknown) =>
    JSON.stringify({
      app: "contextos",
      schemaVersion: 13,
      preferences: { locale: "en", localAssistantHistory: history },
      data: {},
    });

  it("brings the old transcript back as one conversation", async () => {
    const db = new Database(new MemoryStorageAdapter());
    const result = await db.importAll(oldExport(LEGACY));

    expect(result.ok).toBe(true);
    const conversations = db.collection("conversations").getAll();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.origin).toBe("legacyHistory");
    expect(db.prefs.get()).not.toHaveProperty("localAssistantHistory");
  });

  it("merges it beside the conversations already here", async () => {
    const db = new Database(new MemoryStorageAdapter());
    await db.importAll(oldExport(LEGACY));
    await db.importAll(oldExport(LEGACY), { mode: "merge" });
    expect(db.collection("conversations").getAll()).toHaveLength(2);
  });

  it("adds nothing for an empty old transcript", async () => {
    const db = new Database(new MemoryStorageAdapter());
    await db.importAll(oldExport([]));
    expect(db.collection("conversations").getAll()).toEqual([]);
  });

  it("round-trips conversations through export and import", async () => {
    const source = new Database(v13Store());
    const json = source.exportAll();
    expect(JSON.parse(json).preferences).not.toHaveProperty("localAssistantHistory");

    const target = new Database(new MemoryStorageAdapter());
    await target.importAll(json);
    expect(target.collection("conversations").getAll()).toEqual(
      source.collection("conversations").getAll(),
    );
  });
});
