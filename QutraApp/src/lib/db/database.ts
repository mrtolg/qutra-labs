import { useSyncExternalStore } from "react";
import {
  collectionSchemas,
  PreferencesSchema,
  type CollectionName,
  type CollectionRecord,
  type Preferences,
} from "@/domain/types";
import { LocalStorageAdapter, type StorageAdapter } from "./storage";
import { quarantine, readQuarantine, type QuarantineEntry } from "./quarantine";
import {
  runMigrations,
  CURRENT_SCHEMA_VERSION,
  RETIRED_ARCHIVE_KEY,
} from "./migrations";
import { detectRuntime } from "@/lib/runtime";
import { createId } from "@/lib/id";
import { conversationFromLegacyHistory } from "@/domain/conversations";
import {
  agentConsentNeedsPersist,
  migrateAgentConsentOnLoad,
  sanitizeImportedAgentConsent,
} from "@/domain/assistantConsent";

/* ============================================================
   Reactive document store with zod validation at the boundary.
   Every collection is an ordered array persisted per key.
   ============================================================ */

type Row = { id: string };
type ImportMode = "replace" | "merge";

/** Resolves to false only when `shouldCommit` withdrew the write. */
async function writeDurable(
  storage: StorageAdapter,
  changes: Readonly<Record<string, string | null>>,
  shouldCommit?: () => boolean,
): Promise<boolean> {
  if (storage.writeBatchDurable) {
    // An adapter from before the commit check resolves undefined: committed.
    return (await storage.writeBatchDurable(changes, { shouldCommit })) !== false;
  }
  if (shouldCommit && !shouldCommit()) return false;

  const before = new Map<string, string | null>();
  for (const key of Object.keys(changes)) before.set(key, storage.read(key));
  try {
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) storage.remove(key);
      else storage.write(key, value);
    }
    if (storage.flush) await storage.flush();
  } catch (error) {
    for (const [key, value] of before) {
      if (value === null) storage.remove(key);
      else storage.write(key, value);
    }
    throw error;
  }
  return true;
}

/** Same stored document: key order and undefined fields do not count, as
    neither survives the JSON round trip through storage. */
export function sameDocument(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}

/** One queue per document so a later RMW reads the previous write, not the same snapshot. */
function createWriteQueue() {
  let tail: Promise<void> = Promise.resolve();
  return function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

class Collection<N extends CollectionName> {
  private rows: CollectionRecord<N>[] = [];
  private listeners = new Set<() => void>();
  private snapshot: CollectionRecord<N>[] = [];
  private readonly enqueueWrite = createWriteQueue();

  constructor(
    private readonly name: N,
    private readonly storage: StorageAdapter,
  ) {
    this.load();
  }

  private load() {
    const raw = this.storage.read(this.name);
    if (!raw) {
      this.rows = [];
      this.snapshot = [];
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed)) {
      // Kept before the next write replaces the collection.
      quarantine(this.storage, [
        { collection: this.name, at: Date.now(), reason: "unreadable_collection", value: raw },
      ]);
      this.rows = [];
      this.snapshot = [];
      return;
    }
    const schema = collectionSchemas[this.name];
    const valid: CollectionRecord<N>[] = [];
    const rejected: QuarantineEntry[] = [];
    for (const item of parsed) {
      const result = schema.safeParse(item);
      if (result.success) valid.push(result.data as CollectionRecord<N>);
      else {
        rejected.push({ collection: this.name, at: Date.now(), reason: "invalid_record", value: item });
      }
    }
    quarantine(this.storage, rejected);
    this.rows = valid;
    this.snapshot = [...valid];
  }

  private persist() {
    this.storage.write(this.name, JSON.stringify(this.rows));
    this.snapshot = [...this.rows];
    this.listeners.forEach((l) => l());
  }

  private publish(rows: CollectionRecord<N>[]) {
    this.rows = rows;
    this.snapshot = [...rows];
    this.listeners.forEach((listener) => listener());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getAll = (): CollectionRecord<N>[] => this.snapshot;

  get(id: string): CollectionRecord<N> | undefined {
    return this.rows.find((r) => (r as Row).id === id);
  }

  put(record: CollectionRecord<N>): CollectionRecord<N> {
    const schema = collectionSchemas[this.name];
    const parsed = schema.parse(record) as CollectionRecord<N>;
    const idx = this.rows.findIndex(
      (r) => (r as Row).id === (parsed as Row).id,
    );
    if (idx >= 0) this.rows[idx] = parsed;
    else this.rows.push(parsed);
    this.persist();
    return parsed;
  }

  private async commitPut(
    record: CollectionRecord<N>,
  ): Promise<CollectionRecord<N>> {
    const schema = collectionSchemas[this.name];
    const parsed = schema.parse(record) as CollectionRecord<N>;
    const next = [...this.rows];
    const idx = next.findIndex(
      (row) => (row as Row).id === (parsed as Row).id,
    );
    if (idx >= 0) next[idx] = parsed;
    else next.push(parsed);
    await writeDurable(this.storage, {
      [this.name]: JSON.stringify(next),
    });
    this.publish(next);
    return parsed;
  }

  async putDurable(
    record: CollectionRecord<N>,
  ): Promise<CollectionRecord<N>> {
    return this.enqueueWrite(() => this.commitPut(record));
  }

  patch(
    id: string,
    changes: Partial<CollectionRecord<N>>,
  ): CollectionRecord<N> | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    return this.put({ ...existing, ...changes } as CollectionRecord<N>);
  }

  async patchDurable(
    id: string,
    changes: Partial<CollectionRecord<N>>,
  ): Promise<CollectionRecord<N> | undefined> {
    return this.enqueueWrite(async () => {
      const existing = this.get(id);
      if (!existing) return undefined;
      return this.commitPut({
        ...existing,
        ...changes,
      } as CollectionRecord<N>);
    });
  }

  /** Read-modify-write in this collection's queue. `change` sees the row as
      it is when the write runs, not when it was scheduled, and returns
      undefined to write nothing. */
  async updateDurable(
    id: string,
    change: (existing: CollectionRecord<N>) => CollectionRecord<N> | undefined,
  ): Promise<CollectionRecord<N> | undefined> {
    return this.enqueueWrite(async () => {
      const existing = this.get(id);
      if (!existing) return undefined;
      const next = change(existing);
      if (!next) return undefined;
      return this.commitPut({ ...next, id } as CollectionRecord<N>);
    });
  }

  remove(id: string): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => (r as Row).id !== id);
    if (this.rows.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  async removeDurable(id: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const next = this.rows.filter((row) => (row as Row).id !== id);
      if (next.length === this.rows.length) return false;
      await writeDurable(this.storage, {
        [this.name]: JSON.stringify(next),
      });
      this.publish(next);
      return true;
    });
  }

  removeWhere(predicate: (r: CollectionRecord<N>) => boolean): number {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !predicate(r));
    const removed = before - this.rows.length;
    if (removed > 0) this.persist();
    return removed;
  }

  /**
   * Upsert a batch as one durable write in this collection's queue. The diff
   * runs when the write runs, against the rows as they are then, so a batch
   * that changes nothing writes nothing and notifies nobody. `changed` decides
   * what counts as a change (default: any field differs); `shouldCommit` is
   * asked at the same moment, so a caller can withdraw a batch still queued.
   * Resolves to the number of rows written.
   */
  async upsertManyDurable(
    records: CollectionRecord<N>[],
    options: {
      changed?: (
        existing: CollectionRecord<N>,
        next: CollectionRecord<N>,
      ) => boolean;
      shouldCommit?: () => boolean;
    } = {},
  ): Promise<number> {
    const schema = collectionSchemas[this.name];
    const parsed = records.map(
      (record) => schema.parse(record) as CollectionRecord<N>,
    );
    const changed =
      options.changed ?? ((existing, next) => !sameDocument(existing, next));
    return this.enqueueWrite(async () => {
      if (options.shouldCommit && !options.shouldCommit()) return 0;
      const next = [...this.rows];
      const indexById = new Map(
        next.map((row, index) => [(row as Row).id, index]),
      );
      let written = 0;
      for (const record of parsed) {
        const id = (record as Row).id;
        const index = indexById.get(id);
        if (index === undefined) {
          indexById.set(id, next.length);
          next.push(record);
          written += 1;
        } else if (changed(next[index], record)) {
          next[index] = record;
          written += 1;
        }
      }
      if (written === 0) return 0;
      const committed = await writeDurable(
        this.storage,
        { [this.name]: JSON.stringify(next) },
        options.shouldCommit,
      );
      // Withdrawn at the storage boundary: nothing was written, so nothing
      // is published.
      if (!committed) return 0;
      this.publish(next);
      return written;
    });
  }

  bulkPut(records: CollectionRecord<N>[]): void {
    const schema = collectionSchemas[this.name];
    for (const record of records) {
      const parsed = schema.parse(record) as CollectionRecord<N>;
      const idx = this.rows.findIndex(
        (r) => (r as Row).id === (parsed as Row).id,
      );
      if (idx >= 0) this.rows[idx] = parsed;
      else this.rows.push(parsed);
    }
    this.persist();
  }

  /** Reload after an adapter-owned transaction without issuing another write. */
  reload(): void {
    this.load();
    this.listeners.forEach((listener) => listener());
  }

  /** Empty the collection behind every write already queued for it. */
  async clearDurable(): Promise<void> {
    return this.enqueueWrite(async () => {
      await writeDurable(this.storage, { [this.name]: JSON.stringify([]) });
      this.publish([]);
    });
  }

  clear(): void {
    this.rows = [];
    this.persist();
  }
}

class PreferencesStore {
  private value: Preferences;
  private listeners = new Set<() => void>();
  private readonly enqueueWrite = createWriteQueue();

  constructor(private readonly storage: StorageAdapter) {
    const raw = storage.read("preferences");
    let parsed: Preferences | null = null;
    if (raw) {
      try {
        const result = PreferencesSchema.safeParse(JSON.parse(raw));
        if (result.success) parsed = result.data;
      } catch {
        parsed = null;
      }
    }
    const initial = parsed ?? PreferencesSchema.parse({});
    this.value = migrateAgentConsentOnLoad(initial);
    if (parsed && agentConsentNeedsPersist(parsed, this.value)) {
      this.storage.write("preferences", JSON.stringify(this.value));
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (): Preferences => this.value;

  set(changes: Partial<Preferences>): Preferences {
    this.value = PreferencesSchema.parse({ ...this.value, ...changes });
    this.storage.write("preferences", JSON.stringify(this.value));
    this.listeners.forEach((l) => l());
    return this.value;
  }

  /** Persist preferences and await durable flush when the adapter supports it. */
  async setDurable(changes: Partial<Preferences>): Promise<Preferences> {
    return this.enqueueWrite(async () => {
      const next = PreferencesSchema.parse({ ...this.value, ...changes });
      await writeDurable(this.storage, {
        preferences: JSON.stringify(next),
      });
      this.value = next;
      this.listeners.forEach((listener) => listener());
      return next;
    });
  }

  /** Replace preferences wholesale (import/restore). */
  replaceAll(prefs: Preferences): Preferences {
    this.value = sanitizeImportedAgentConsent(PreferencesSchema.parse(prefs));
    this.storage.write("preferences", JSON.stringify(this.value));
    this.listeners.forEach((l) => l());
    return this.value;
  }

  async replaceAllDurable(prefs: Preferences): Promise<Preferences> {
    return this.enqueueWrite(async () => {
      const next = sanitizeImportedAgentConsent(PreferencesSchema.parse(prefs));
      await writeDurable(this.storage, {
        preferences: JSON.stringify(next),
      });
      this.value = next;
      this.listeners.forEach((listener) => listener());
      return next;
    });
  }

  /** Reload after an adapter-owned transaction without issuing another write. */
  reload(): void {
    const raw = this.storage.read("preferences");
    let parsed: Preferences = PreferencesSchema.parse({});
    if (raw) {
      try {
        const result = PreferencesSchema.safeParse(JSON.parse(raw));
        if (result.success) parsed = result.data;
      } catch {
        parsed = PreferencesSchema.parse({});
      }
    }
    this.value = migrateAgentConsentOnLoad(parsed);
    this.listeners.forEach((listener) => listener());
  }

  reset(keys?: (keyof Preferences)[]): Preferences {
    const defaults = PreferencesSchema.parse({});
    if (!keys) {
      this.value = defaults;
    } else {
      const next = { ...this.value } as Record<string, unknown>;
      for (const k of keys) next[k] = defaults[k];
      this.value = PreferencesSchema.parse(next);
    }
    this.storage.write("preferences", JSON.stringify(this.value));
    this.listeners.forEach((l) => l());
    return this.value;
  }
}

export class Database {
  readonly storage: StorageAdapter;
  readonly prefs: PreferencesStore;
  private cols = new Map<CollectionName, Collection<CollectionName>>();

  constructor(storage?: StorageAdapter) {
    this.storage = storage ?? new LocalStorageAdapter();
    runMigrations(this.storage);
    this.prefs = new PreferencesStore(this.storage);
  }

  collection<N extends CollectionName>(name: N): Collection<N> {
    let col = this.cols.get(name);
    if (!col) {
      col = new Collection(name, this.storage) as Collection<CollectionName>;
      this.cols.set(name, col);
    }
    return col as unknown as Collection<N>;
  }

  /** Remove every record flagged as demo data across all collections. */
  removeDemoData(): number {
    let removed = 0;
    for (const name of Object.keys(collectionSchemas) as CollectionName[]) {
      const col = this.collection(name);
      removed += col.removeWhere(
        (r) => (r as { demo?: boolean }).demo === true,
      );
    }
    return removed;
  }

  /** Records set aside because this version could not read them.
      Collections load lazily and set aside what they cannot read as they
      load, so every collection is loaded first. Nothing is at risk in one
      that never loads: a collection is written only from rows it loaded. */
  quarantined(): QuarantineEntry[] {
    for (const name of Object.keys(collectionSchemas) as CollectionName[]) {
      this.collection(name);
    }
    return readQuarantine(this.storage);
  }

  /** Schema-versioned full export. Includes preferences (restored by importAll)
      and the records kept aside, which importAll leaves alone. */
  exportAll(): string {
    const data: Record<string, unknown> = {};
    for (const name of Object.keys(collectionSchemas) as CollectionName[]) {
      data[name] = this.collection(name).getAll();
    }
    // Read after every collection loaded, so it holds all they set aside.
    const quarantine = readQuarantine(this.storage);
    return JSON.stringify(
      {
        app: "contextos",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        preferences: this.prefs.get(),
        data,
        ...(quarantine.length > 0 ? { quarantine } : {}),
      },
      null,
      2,
    );
  }

  /**
   * Import a full export. Restores collections and preferences.
   * When the storage adapter supports flush(), waits for durable write
   * and fails the import if persistence rejects.
   */
  async importAll(
    json: string,
    options: { mode?: ImportMode } = {},
  ): Promise<{
    ok: boolean;
    imported: number;
    mode: ImportMode;
    error?: string;
  }> {
    const mode = options.mode ?? "replace";
    try {
      const parsed = JSON.parse(json) as {
        app?: unknown;
        data?: Record<string, unknown>;
        preferences?: unknown;
      };
      if (
        parsed.app !== "contextos" ||
        !parsed.data ||
        typeof parsed.data !== "object" ||
        Array.isArray(parsed.data)
      ) {
        return {
          ok: false,
          imported: 0,
          mode,
          error: "unrecognized_format",
        };
      }

      const preferences = PreferencesSchema.safeParse(parsed.preferences);
      if (!preferences.success) {
        return {
          ok: false,
          imported: 0,
          mode,
          error: "invalid_preferences",
        };
      }

      // An export from before conversations (schema < 14) carries the single
      // transcript in its preferences; it arrives as one conversation, as
      // migration v14 does for local data.
      const legacyConversation = conversationFromLegacyHistory(
        typeof parsed.preferences === "object" && parsed.preferences !== null
          ? (parsed.preferences as Record<string, unknown>).localAssistantHistory
          : undefined,
        Date.now(),
        createId,
      );

      let imported = 0;
      const changes: Record<string, string> = {
        preferences: JSON.stringify(sanitizeImportedAgentConsent(preferences.data)),
      };
      for (const name of Object.keys(collectionSchemas) as CollectionName[]) {
        const rows = parsed.data[name] ?? [];
        if (!Array.isArray(rows)) {
          return {
            ok: false,
            imported: 0,
            mode,
            error: `invalid_collection:${name}`,
          };
        }
        const schema = collectionSchemas[name];
        const valid: unknown[] = [];
        for (const row of rows) {
          const result = schema.safeParse(row);
          if (!result.success) {
            return {
              ok: false,
              imported: 0,
              mode,
              error: `invalid_collection:${name}`,
            };
          }
          if (name === "engagements") {
            // A cloud allowance is given on this machine, by its user, for
            // the connection it has: an import never brings one.
            const engagement: Record<string, unknown> = { ...(result.data as object) };
            delete engagement.cloudConsent;
            valid.push(engagement);
          } else {
            valid.push(result.data);
          }
        }
        if (name === "conversations" && legacyConversation) {
          valid.push(legacyConversation);
        }
        imported += valid.length;

        if (mode === "merge") {
          const merged = new Map<string, unknown>();
          for (const row of this.collection(name).getAll()) {
            merged.set((row as Row).id, row);
          }
          for (const row of valid) merged.set((row as Row).id, row);
          changes[name] = JSON.stringify([...merged.values()]);
        } else {
          changes[name] = JSON.stringify(valid);
        }
      }

      await writeDurable(this.storage, changes);
      for (const collection of this.cols.values()) collection.reload();
      this.prefs.reload();
      return { ok: true, imported, mode };
    } catch (error) {
      return {
        ok: false,
        imported: 0,
        mode,
        error:
          error instanceof SyntaxError ? "parse_error" : "persistence_error",
      };
    }
  }

  /** Complete local data deletion, including the native retired-data archive. */
  async deleteEverything(): Promise<void> {
    // Conversations first, behind any turn still being written, so a late
    // append cannot land after the wipe (TM-006).
    await this.collection("conversations").clearDurable();
    // Clear collections first (notifies subscribers), then wipe every
    // stored key so no empty-array documents are left behind.
    for (const name of Object.keys(collectionSchemas) as CollectionName[]) {
      this.collection(name).clear();
    }
    for (const key of this.storage.keys()) {
      this.storage.remove(key);
    }
    if (detectRuntime() === "tauri") {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_retired_archive");
    }
  }

  estimateSizeBytes(): number {
    return this.storage.estimateSizeBytes();
  }
}

/* ---------- Singleton + React bindings ---------- */

let dbInstance: Database | null = null;
let dbStorageKind: "localStorage" | "sqlite" | "memory" = "localStorage";

/**
 * Boot the database for the current runtime.
 *
 * - Tauri  → open SQLite, run migrations (native), mirror into memory.
 * - Browser → synchronous localStorage (unchanged demo/dev behavior).
 *
 * Must be awaited before rendering on the desktop; the browser path
 * resolves synchronously-fast. Safe to call more than once.
 */
export async function initDb(): Promise<Database> {
  if (dbInstance) return dbInstance;
  if (detectRuntime() === "tauri") {
    const { SqliteAdapter } = await import("./sqliteAdapter");
    const adapter = await SqliteAdapter.create();
    dbInstance = new Database(adapter);
    const archive = adapter.read(RETIRED_ARCHIVE_KEY);
    if (archive) {
      // A failed archive must not stop the app from starting: the key stays,
      // and the next start tries again.
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke<string>("archive_retired_data", { archiveJson: archive });
        adapter.remove(RETIRED_ARCHIVE_KEY);
      } catch (error) {
        console.warn("retired data archive not written:", error);
      }
    }
    dbStorageKind = "sqlite";
  } else {
    dbInstance = new Database();
    dbStorageKind = "localStorage";
  }
  return dbInstance;
}

export function getDb(): Database {
  if (!dbInstance) dbInstance = new Database();
  return dbInstance;
}

/** Which backend the live database is using (About/diagnostics). */
export function getStorageKind(): "localStorage" | "sqlite" | "memory" {
  return dbStorageKind;
}

/** Test hook: swap the singleton for an isolated instance. */
export function setDbForTesting(db: Database | null): void {
  dbInstance = db;
  dbStorageKind = db ? "memory" : "localStorage";
}

export function useCollection<N extends CollectionName>(
  name: N,
): CollectionRecord<N>[] {
  const col = getDb().collection(name);
  return useSyncExternalStore(col.subscribe, col.getAll, col.getAll);
}

export function usePreferences(): Preferences {
  const prefs = getDb().prefs;
  return useSyncExternalStore(prefs.subscribe, prefs.get, prefs.get);
}
