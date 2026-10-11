import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Found in a manual test on 2026-10-05: a language change in Settings did not
   stick and the app logged "SQLite write failed: database is locked". The
   adapter sent BEGIN, each statement and COMMIT as separate plugin calls, and
   the plugin runs each call on any connection of a sqlx pool, so a
   transaction could be split across connections and strand the write lock.
   Every write now goes to Rust as one batch (src-tauri/src/storage_writes.rs). */

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

/* The boot read is a Rust command too (`storage_load`): the window holds no
   SQL plugin permission, so the tests answer that command through `invoke`. */
type Snapshot = {
  records: { collection: string; id: string; data: string }[];
  kv: { key: string; value: string }[];
};
/** What `storage_load` answers; every other command resolves to nothing. */
let snapshot: Snapshot;
const answer = async (command: string): Promise<unknown> =>
  command === "storage_load" ? snapshot : undefined;

import { SqliteAdapter } from "./sqliteAdapter";
import { Database } from "./database";
import type { ToolInstallation } from "@/domain/lab";

const DB = "sqlite:contextos.db";

async function adapter(seed: { kv?: Record<string, string> } = {}) {
  snapshot = {
    records: [],
    kv: Object.entries(seed.kv ?? {}).map(([key, value]) => ({ key, value })),
  };
  return SqliteAdapter.create();
}

function sentBatches() {
  return invoke.mock.calls
    .filter(([command]) => command === "storage_apply_writes")
    .map(([, args]) => args as { db: string; writes: unknown[] });
}

beforeEach(() => {
  snapshot = { records: [], kv: [] };
  invoke.mockImplementation(answer);
});

afterEach(() => {
  invoke.mockReset();
  vi.restoreAllMocks();
});

describe("SqliteAdapter reads", () => {
  it("boots from the Rust command, never from the SQL plugin", async () => {
    snapshot = {
      records: [{ collection: "tasks", id: "a", data: '{"id":"a"}' }],
      kv: [{ key: "preferences", value: '{"locale":"en"}' }],
    };
    const store = await SqliteAdapter.create();
    await store.flush();

    expect(invoke).toHaveBeenCalledWith("storage_load", { db: DB });
    expect(invoke.mock.calls.every(([command]) => !String(command).startsWith("plugin:sql"))).toBe(
      true,
    );
    expect(JSON.parse(store.read("tasks")!)).toEqual([{ id: "a" }]);
    expect(store.read("preferences")).toBe('{"locale":"en"}');
  });
});

describe("SqliteAdapter writes", () => {
  it("sends a scalar key as one batch", async () => {
    const store = await adapter();
    store.write("preferences", '{"locale":"en"}');
    await store.flush();

    expect(sentBatches()).toEqual([
      { db: DB, writes: [{ kind: "setKv", key: "preferences", value: '{"locale":"en"}' }] },
    ]);
    expect(store.read("preferences")).toBe('{"locale":"en"}');
  });

  it("replaces a collection as one batch, record by record", async () => {
    const store = await adapter();
    const tasks = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    store.write("tasks", JSON.stringify(tasks));
    await store.flush();

    expect(sentBatches()).toEqual([
      {
        db: DB,
        writes: [
          {
            kind: "replaceCollection",
            collection: "tasks",
            records: [
              { id: "a", data: JSON.stringify(tasks[0]) },
              { id: "b", data: JSON.stringify(tasks[1]) },
            ],
          },
        ],
      },
    ]);
  });

  it("sends a removal as one batch", async () => {
    const store = await adapter({ kv: { notes: "[]" } });
    store.remove("notes");
    await store.flush();

    expect(sentBatches()).toEqual([{ db: DB, writes: [{ kind: "remove", key: "notes" }] }]);
    expect(store.read("notes")).toBeNull();
  });

  it("commits a durable change set in one call before the mirror moves", async () => {
    const store = await adapter({ kv: { preferences: "old", meta: "m" } });
    let release!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));

    const pending = store.writeBatchDurable({ preferences: "new", meta: null });
    await vi.waitFor(() => expect(sentBatches()).toHaveLength(1));
    expect(store.read("preferences")).toBe("old");

    release();
    await pending;
    expect(sentBatches()[0]).toEqual({
      db: DB,
      writes: [
        { kind: "setKv", key: "preferences", value: "new" },
        { kind: "remove", key: "meta" },
      ],
    });
    expect(store.read("preferences")).toBe("new");
    expect(store.read("meta")).toBeNull();
  });

  it("keeps the mirror when a durable change set fails, and goes on writing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await adapter({ kv: { preferences: "old" } });
    invoke.mockRejectedValueOnce(new Error("database is locked"));

    await expect(store.writeBatchDurable({ preferences: "new" })).rejects.toThrow("locked");
    expect(store.read("preferences")).toBe("old");

    await store.writeBatchDurable({ preferences: "newer" });
    expect(store.read("preferences")).toBe("newer");
  });

  it("never splits a transaction into separate plugin calls", async () => {
    const store = await adapter();
    store.write("preferences", "{}");
    store.write("tasks", JSON.stringify([{ id: "a" }]));
    store.remove("notes");
    await store.writeBatchDurable({ meta: "x" });
    await store.flush();

    const commands = new Set(invoke.mock.calls.map(([command]) => command));
    expect([...commands].sort()).toEqual(["storage_apply_writes", "storage_load"]);
  });

  it("drops a durable change set withdrawn while it waited behind other writes", async () => {
    const store = await adapter({ kv: { preferences: "old" } });
    let release!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const callsBefore = invoke.mock.calls.length;
    store.write("meta", "unrelated"); // holds the write queue
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(callsBefore + 1));
    let allowed = true;

    const pending = store.writeBatchDurable(
      { preferences: "new" },
      { shouldCommit: () => allowed },
    );
    allowed = false; // withdrawn before its turn
    release();

    await expect(pending).resolves.toBe(false);
    expect(sentBatches()).toHaveLength(1);
    expect(store.read("preferences")).toBe("old");
  });
});

/* Revoking Private Lab must reach Lab mirror batches that are
   already waiting in the SQLite queue, not only those still in their
   collection's queue. */
describe("Lab mirror batches and revocation", () => {
  function installation(id: string): ToolInstallation {
    return {
      id,
      displayName: id,
      runner: "executable",
      path: `C:\tools\${id}.exe`,
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      sizeBytes: 1,
      version: "1",
      publisher: "",
      signatureState: "unsigned",
      category: "local",
      riskTier: "low",
      docUrl: "",
      iconEmoji: "",
      tags: [],
      workingDir: "C:\tools",
      enabled: true,
      changedSinceVerify: false,
      demo: false,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  it("a batch revoked while the SQLite queue was busy is neither written nor published", async () => {
    const store = await adapter();
    const db = new Database(store);
    await store.flush();
    const installations = db.collection("toolInstallations");
    const published = vi.fn();
    installations.subscribe(published);

    let release!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const callsBefore = invoke.mock.calls.length;
    store.write("meta", "unrelated"); // an earlier, unrelated write holds the queue
    await vi.waitFor(() => expect(invoke.mock.calls.length).toBe(callsBefore + 1));
    let granted = true;
    const batch = installations.upsertManyDurable([installation("nmap")], {
      shouldCommit: () => granted,
    });
    await Promise.resolve();
    granted = false; // Private Lab revoked; revoke has returned
    release();

    await expect(batch).resolves.toBe(0);
    expect(published).not.toHaveBeenCalled();
    expect(installations.getAll()).toEqual([]);
    const wroteInstallations = sentBatches().some(({ writes }) =>
      writes.some(
        (w) =>
          (w as { kind: string; collection?: string }).kind === "replaceCollection" &&
          (w as { collection?: string }).collection === "toolInstallations",
      ),
    );
    expect(wroteInstallations).toBe(false);
  });
});

/* writeBatch, which boot migrations use: one unit that commits all or
   none, whose keys ride in the next write when their batch did not commit.
   This stand-in for storage_apply_writes applies a batch all or nothing and
   can be made to refuse. */
describe("SqliteAdapter.writeBatch", () => {
  type Write =
    | { kind: "replaceCollection"; collection: string; records: { id: string; data: string }[] }
    | { kind: "setKv"; key: string; value: string }
    | { kind: "remove"; key: string };
  type Disk = { kv: Map<string, string>; records: Map<string, Map<string, string>> };

  const LEGACY_PREFS = JSON.stringify({
    locale: "tr",
    localAssistantHistory: [{ role: "user", content: "hi" }],
  });
  const CONVERSATION = JSON.stringify([{ id: "conv_1", title: "hi" }]);
  let disk: Disk;
  let refuseBatches = 0;

  beforeEach(() => {
    disk = { kv: new Map([["preferences", LEGACY_PREFS]]), records: new Map() };
    refuseBatches = 0;
    invoke.mockImplementation(async (command: string, args: { writes: Write[] }) => {
      if (command === "storage_load") {
        return {
          records: [...disk.records].flatMap(([collection, rows]) =>
            [...rows].map(([id, data]) => ({ collection, id, data })),
          ),
          kv: [...disk.kv].map(([key, value]) => ({ key, value })),
        };
      }
      if (refuseBatches > 0) {
        refuseBatches -= 1;
        throw new Error("database is locked");
      }
      for (const w of args.writes) {
        if (w.kind === "setKv") disk.kv.set(w.key, w.value);
        else if (w.kind === "remove") {
          disk.kv.delete(w.key);
          disk.records.delete(w.key);
        } else {
          disk.records.set(w.collection, new Map(w.records.map((r) => [r.id, r.data])));
        }
      }
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const settled = (adapter: { flush(): Promise<void> }) => adapter.flush().catch(() => undefined);

  it("commits every key in one batch", async () => {
    const store = await SqliteAdapter.create();
    store.writeBatch({ conversations: CONVERSATION, preferences: '{"locale":"tr"}' });
    await store.flush();

    expect(sentBatches()).toHaveLength(1);
    expect(disk.records.get("conversations")?.has("conv_1")).toBe(true);
    expect(disk.kv.get("preferences")).toBe('{"locale":"tr"}');
  });

  /* Migration v14 strips the transcript from preferences and adds it as a
     conversation in one batch. If that batch does not commit and a later
     preferences save commits alone, the disk holds neither copy. */
  it("a batch that did not commit is committed with the next write, not lost to it", async () => {
    const store = await SqliteAdapter.create();
    refuseBatches = 1;
    store.writeBatch({ conversations: CONVERSATION, preferences: '{"locale":"tr"}' });
    store.write("preferences", '{"locale":"en"}');
    await settled(store);

    expect(disk.records.get("conversations")?.has("conv_1")).toBe(true);
    expect(disk.kv.get("preferences")).toBe('{"locale":"en"}');
  });

  it("an unrelated write carries the unsettled batch too", async () => {
    const store = await SqliteAdapter.create();
    refuseBatches = 1;
    store.writeBatch({ conversations: CONVERSATION, preferences: '{"locale":"tr"}' });
    store.write("meta", '{"schemaVersion":14}');
    await settled(store);

    expect(disk.records.get("conversations")?.has("conv_1")).toBe(true);
    expect(disk.kv.get("preferences")).toBe('{"locale":"tr"}');
    expect(disk.kv.get("meta")).toBe('{"schemaVersion":14}');
  });

  it("while the batch cannot commit, no later write commits without it", async () => {
    const store = await SqliteAdapter.create();
    refuseBatches = 2;
    store.writeBatch({ conversations: CONVERSATION, preferences: '{"locale":"tr"}' });
    store.write("preferences", '{"locale":"en"}');
    await settled(store);

    // Both attempts refused: the disk still has the legacy shape, so the
    // next boot migrates again.
    expect(disk.kv.get("preferences")).toBe(LEGACY_PREFS);
    expect(disk.records.has("conversations")).toBe(false);

    store.remove("viewSettings");
    await settled(store);
    expect(disk.records.get("conversations")?.has("conv_1")).toBe(true);
    expect(disk.kv.get("preferences")).toBe('{"locale":"en"}');
  });

  it("settles once, then writes go back to committing alone", async () => {
    const store = await SqliteAdapter.create();
    refuseBatches = 1;
    store.writeBatch({ conversations: CONVERSATION, preferences: '{"locale":"tr"}' });
    store.write("meta", "{}");
    await settled(store);

    disk.records.delete("conversations");
    store.write("preferences", '{"locale":"de"}');
    await store.flush();
    expect(disk.records.has("conversations")).toBe(false);
  });
});

/* A stored record whose text is not JSON used to be skipped on load,
   and the next write of its collection deleted it from disk. */
describe("SqliteAdapter load", () => {
  it("keeps a stored record whose text is not JSON aside", async () => {
    snapshot = {
      records: [
        { collection: "tasks", id: "ok", data: '{"id":"ok"}' },
        { collection: "tasks", id: "bad", data: "{oops" },
      ],
      kv: [],
    };
    const store = await SqliteAdapter.create();
    expect(JSON.parse(store.read("tasks")!)).toEqual([{ id: "ok" }]);
    expect(JSON.parse(store.read("quarantine_v1")!)).toEqual([
      expect.objectContaining({
        collection: "tasks",
        reason: "unreadable_record",
        value: { id: "bad", data: "{oops" },
      }),
    ]);
  });

  it("commits a quarantine that failed together with the next write", async () => {
    snapshot = { records: [{ collection: "tasks", id: "bad", data: "{oops" }], kv: [] };
    let refused = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "storage_load") return snapshot;
      if (!refused) {
        refused = true; // the quarantine's own batch
        throw new Error("disk full");
      }
      return undefined;
    });
    const store = await SqliteAdapter.create();
    await store.flush().catch(() => undefined);
    // The next write replaces the collection on disk; the record it no longer
    // holds must reach the quarantine in the same batch.
    store.write("tasks", "[]");
    await store.flush();
    const last = sentBatches().at(-1)!;
    expect(last.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "setKv", key: "quarantine_v1" }),
        expect.objectContaining({ kind: "replaceCollection", collection: "tasks" }),
      ]),
    );
  });
});
