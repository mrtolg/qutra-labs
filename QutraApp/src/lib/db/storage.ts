/**
 * Storage adapter boundary.
 *
 * In browser/demo mode records persist as JSON documents in localStorage.
 * In the Tauri build the same interface is backed by SQLite through the
 * official SQL plugin (see src-tauri/migrations). The web layer never
 * talks to a storage engine directly — always through this adapter.
 */

export interface StorageAdapter {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
  estimateSizeBytes(): number;
  /** Optional: await durable persistence (SQLite). Throws on write failure. */
  flush?: () => Promise<void>;
  /**
   * Apply several key changes as one unit without waiting: reads see all of
   * them at once, and durable storage commits all or none. Boot migrations
   * use it where a crash between two writes would lose or duplicate data.
   */
  writeBatch(changes: Readonly<Record<string, string | null>>): void;
  /**
   * Atomically persist a set of key replacements/removals. Durable product
   * workflows use this boundary so UI state changes only after storage commits.
   */
  writeBatchDurable?: (
    changes: Readonly<Record<string, string | null>>,
    options?: DurableWriteOptions,
  ) => Promise<boolean>;
}

export interface DurableWriteOptions {
  /**
   * Asked at the adapter's own write boundary, right before the batch
   * starts, after any writes queued ahead of it. `false` withdraws the
   * batch: nothing is written and the call resolves to `false`. This is how
   * a revoke reaches a batch already waiting in the storage queue (data
   * contracts §8).
   */
  shouldCommit?: () => boolean;
}

export const STORAGE_PREFIX = "contextos.v1.";

export class LocalStorageAdapter implements StorageAdapter {
  read(key: string): string | null {
    try {
      return localStorage.getItem(STORAGE_PREFIX + key);
    } catch {
      return null;
    }
  }
  write(key: string, value: string): void {
    localStorage.setItem(STORAGE_PREFIX + key, value);
  }
  remove(key: string): void {
    localStorage.removeItem(STORAGE_PREFIX + key);
  }
  keys(): string[] {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) out.push(k.slice(STORAGE_PREFIX.length));
    }
    return out;
  }
  estimateSizeBytes(): number {
    let total = 0;
    for (const k of this.keys()) {
      total += (this.read(k)?.length ?? 0) * 2; // UTF-16
    }
    return total;
  }

  async writeBatchDurable(
    changes: Readonly<Record<string, string | null>>,
    options: DurableWriteOptions = {},
  ): Promise<boolean> {
    if (options.shouldCommit && !options.shouldCommit()) return false;
    this.writeBatch(changes);
    return true;
  }

  writeBatch(changes: Readonly<Record<string, string | null>>): void {
    const before = new Map<string, string | null>();
    for (const key of Object.keys(changes)) before.set(key, this.read(key));
    try {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) this.remove(key);
        else this.write(key, value);
      }
    } catch (error) {
      for (const [key, value] of before) {
        if (value === null) this.remove(key);
        else this.write(key, value);
      }
      throw error;
    }
  }
}

/** In-memory adapter for tests. */
export class MemoryStorageAdapter implements StorageAdapter {
  private map = new Map<string, string>();
  flush?: () => Promise<void>;
  read(key: string) {
    return this.map.get(key) ?? null;
  }
  write(key: string, value: string) {
    this.map.set(key, value);
  }
  remove(key: string) {
    this.map.delete(key);
  }
  keys() {
    return [...this.map.keys()];
  }
  estimateSizeBytes() {
    let t = 0;
    this.map.forEach((v) => (t += v.length * 2));
    return t;
  }

  async writeBatchDurable(
    changes: Readonly<Record<string, string | null>>,
    options: DurableWriteOptions = {},
  ): Promise<boolean> {
    if (this.flush) await this.flush();
    if (options.shouldCommit && !options.shouldCommit()) return false;
    const next = new Map(this.map);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    this.map = next;
    return true;
  }

  writeBatch(changes: Readonly<Record<string, string | null>>): void {
    const next = new Map(this.map);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    this.map = next;
  }
}
