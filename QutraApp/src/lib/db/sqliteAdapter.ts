import { invoke } from "@tauri-apps/api/core";
import type { DurableWriteOptions, StorageAdapter } from "./storage";
import { quarantine, type QuarantineEntry } from "./quarantine";
import { collectionSchemas } from "@/domain/types";

/**
 * SQLite-backed storage adapter for the Tauri runtime.
 *
 * The whole UI/domain layer reads storage synchronously. To keep that
 * contract while genuinely persisting to SQLite, the adapter mirrors the
 * database into memory at boot (small personal dataset) and write-throughs
 * asynchronously through a serialized queue. Reads are synchronous from the
 * mirror; every mutation is durably persisted.
 *
 * Writes never go through the plugin's `execute`: it runs each call on any
 * connection of a sqlx pool, so a BEGIN, its statements and its COMMIT sent
 * as separate calls can land on different connections. One left inside an
 * open transaction keeps SQLite's write lock and every other write fails
 * with "database is locked". Each write is one batch for the Rust command
 * `storage_apply_writes` (src-tauri/src/storage_writes.rs), which applies it
 * as one transaction on one connection. The boot read is the Rust command
 * `storage_load` too: the window holds no SQL plugin permission, so it cannot
 * run a statement of its own, load another database file or attach one.
 *
 * Layout (see src-tauri/migrations/0001_initial.sql):
 * - one row per record in `records(collection, id, data)` → real indexes +
 *   notes FTS via triggers;
 * - non-collection keys (`preferences`, `meta`) live in `kv`.
 */

const COLLECTION_NAMES = new Set<string>(Object.keys(collectionSchemas));
const DEFAULT_URL = "sqlite:contextos.db";

/** What `storage_load` returns; mirrors the Rust `StorageSnapshot`. */
interface StorageSnapshot {
  records: { collection: string; id: string; data: string }[];
  kv: { key: string; value: string }[];
}

/** One change for `storage_apply_writes`; mirrors the Rust `StorageWrite`. */
type StorageWrite =
  | { kind: "replaceCollection"; collection: string; records: { id: string; data: string }[] }
  | { kind: "setKv"; key: string; value: string }
  | { kind: "remove"; key: string };

function toWrite(key: string, value: string | null): StorageWrite {
  if (value === null) return { kind: "remove", key };
  if (!COLLECTION_NAMES.has(key)) return { kind: "setKv", key, value };
  const list = JSON.parse(value) as { id: string }[];
  return {
    kind: "replaceCollection",
    collection: key,
    records: list.map((record) => ({ id: record.id, data: JSON.stringify(record) })),
  };
}

export class SqliteAdapter implements StorageAdapter {
  private mirror = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Keys of a `writeBatch` whose transaction did not commit (see there). */
  private unsettled = new Set<string>();

  private constructor(
    private readonly url: string,
    seed: Map<string, string>,
  ) {
    this.mirror = seed;
  }

  static async create(url = DEFAULT_URL): Promise<SqliteAdapter> {
    const { records: rows, kv } = await invoke<StorageSnapshot>("storage_load", { db: url });
    const seed = new Map<string, string>();

    // Collections → JSON array blobs keyed by collection name.
    const byCollection = new Map<string, unknown[]>();
    // A record whose text is not JSON is left out of its collection, and the
    // next write of that collection replaces it on disk, so it is kept aside
    // first.
    const unreadable: QuarantineEntry[] = [];
    for (const row of rows) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        unreadable.push({
          collection: row.collection,
          at: Date.now(),
          reason: "unreadable_record",
          value: { id: row.id, data: row.data },
        });
        continue;
      }
      const list = byCollection.get(row.collection) ?? [];
      list.push(parsed);
      byCollection.set(row.collection, list);
    }
    for (const [collection, list] of byCollection) {
      seed.set(collection, JSON.stringify(list));
    }

    // kv → scalar blobs (preferences, meta, view settings, …).
    for (const { key, value } of kv) seed.set(key, value);

    const adapter = new SqliteAdapter(url, seed);
    quarantine(adapter, unreadable);
    return adapter;
  }

  read(key: string): string | null {
    return this.mirror.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.mirror.set(key, value);
    void this.enqueue(() => this.commitSettling({ [key]: value }));
  }

  remove(key: string): void {
    this.mirror.delete(key);
    void this.enqueue(() => this.commitSettling({ [key]: null }));
  }

  keys(): string[] {
    return [...this.mirror.keys()];
  }

  estimateSizeBytes(): number {
    let total = 0;
    this.mirror.forEach((v) => (total += v.length * 2));
    return total;
  }

  async writeBatchDurable(
    changes: Readonly<Record<string, string | null>>,
    options: DurableWriteOptions = {},
  ): Promise<boolean> {
    let committed = false;
    await this.enqueue(async () => {
      // Asked here, when the batch's turn comes, not when it was queued: a
      // revoke while earlier writes ran must still withdraw it.
      if (options.shouldCommit && !options.shouldCommit()) return;
      await this.commitSettling(changes);

      // The synchronous mirror only advances after the durable transaction.
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) this.mirror.delete(key);
        else this.mirror.set(key, value);
      }
      committed = true;
    });
    return committed;
  }

  /** The mirror moves now; storage commits every change as one batch, in
      order behind the writes already queued. If that batch does not
      commit, its keys stay unsettled and ride in the next write's batch,
      so a later single-key write can never commit half of it (boot
      migrations, where a crash between two writes loses or duplicates
      data). */
  writeBatch(changes: Readonly<Record<string, string | null>>): void {
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) this.mirror.delete(key);
      else this.mirror.set(key, value);
    }
    void this.enqueue(async () => {
      try {
        await this.commitSettling(changes);
      } catch (error) {
        for (const key of Object.keys(changes)) this.unsettled.add(key);
        throw error;
      }
    });
  }

  /** Commit `changes` together with any unsettled batch keys, at their
      current mirror values, as one batch. */
  private async commitSettling(changes: Readonly<Record<string, string | null>>): Promise<void> {
    const carried: Record<string, string | null> = {};
    for (const key of this.unsettled) carried[key] = this.mirror.get(key) ?? null;
    const all = { ...carried, ...changes };
    await this.apply(Object.entries(all).map(([key, value]) => toWrite(key, value)));
    this.unsettled.clear();
  }

  /** Await all pending writes. Rejects if any queued write failed. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.catch(() => undefined).then(task);
    this.queue = run;
    void run.catch((err) => {
      console.error("[Qutra Labs] SQLite write failed:", err);
    });
    // `run` remains rejected for flush()/durable callers. A subsequent enqueue
    // starts after a handled predecessor, so one disk error does not poison the
    // adapter forever.
    return run;
  }

  /** One transaction on one connection, or nothing (see the header). */
  private async apply(writes: StorageWrite[]): Promise<void> {
    await invoke("storage_apply_writes", { db: this.url, writes });
  }
}
