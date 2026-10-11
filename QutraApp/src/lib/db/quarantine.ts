import type { StorageAdapter } from "./storage";

/**
 * Records this version cannot read, kept instead of dropped.
 * A collection write replaces the collection's whole document, so a row the
 * loader skipped used to vanish on the next write. It is copied here first.
 * The key is not a collection: no collection write ever replaces it.
 */
export const QUARANTINE_KEY = "quarantine_v1";

export interface QuarantineEntry {
  /** The collection the record was read from. */
  collection: string;
  /** When it was set aside (ms since epoch). */
  at: number;
  /** A row that fails its schema, a collection whose text is not a JSON
      array, or one stored record whose text is not JSON. */
  reason: "invalid_record" | "unreadable_collection" | "unreadable_record";
  /** The row as stored, or the stored text. */
  value: unknown;
}

/* Entries are the same when their collection and value are, so loading the
   same unreadable record again never adds it twice. Two byte-identical rows
   in one collection are therefore kept once: they carry nothing more. */
const fingerprint = (entry: QuarantineEntry) =>
  `${entry.collection}\u0000${JSON.stringify(entry.value)}`;

export function readQuarantine(storage: StorageAdapter): QuarantineEntry[] {
  const raw = storage.read(QUARANTINE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as QuarantineEntry[];
  } catch {
    // Fall through: the unreadable text itself is kept as an entry.
  }
  return [{ collection: QUARANTINE_KEY, at: 0, reason: "unreadable_collection", value: raw }];
}

/** Add the entries not already kept; returns how many were new. */
export function quarantine(storage: StorageAdapter, entries: QuarantineEntry[]): number {
  if (entries.length === 0) return 0;
  const kept = readQuarantine(storage);
  const seen = new Set(kept.map(fingerprint));
  const fresh: QuarantineEntry[] = [];
  for (const entry of entries) {
    const key = fingerprint(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(entry);
  }
  // A batch, not a plain write: on SQLite a batch that fails to commit rides
  // in the next write's batch, so the next collection write cannot drop a
  // record from disk while its quarantine copy is lost.
  if (fresh.length > 0) {
    storage.writeBatch({ [QUARANTINE_KEY]: JSON.stringify([...kept, ...fresh]) });
  }
  return fresh.length;
}
