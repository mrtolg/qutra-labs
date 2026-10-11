import { describe, expect, it, vi } from "vitest";
import { Database } from "./database";
import { MemoryStorageAdapter } from "./storage";
import type { ToolInstallation } from "@/domain/lab";

/* Data contracts §8 (option A): a batch of mirrored records costs at most one
   durable write per collection, and a batch that changes nothing costs none. */

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function installation(
  id: string,
  changes: Partial<ToolInstallation> = {},
): ToolInstallation {
  return {
    id,
    displayName: id,
    runner: "executable",
    path: `C:\\tools\\${id}.exe`,
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
    workingDir: "C:\\tools",
    enabled: true,
    changedSinceVerify: false,
    demo: false,
    createdAt: 1,
    updatedAt: 1,
    ...changes,
  };
}

function setup() {
  const adapter = new MemoryStorageAdapter();
  const db = new Database(adapter);
  const writes = vi.spyOn(adapter, "writeBatchDurable");
  return { adapter, db, writes, col: db.collection("toolInstallations") };
}

describe("Collection.upsertManyDurable", () => {
  it("writes a changed batch once and publishes it after the commit", async () => {
    const { col, writes } = setup();
    const seen: number[] = [];
    col.subscribe(() => seen.push(col.getAll().length));

    const changed = await col.upsertManyDurable([
      installation("a"),
      installation("b"),
      installation("c"),
    ]);

    expect(changed).toBe(3);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(col.getAll().map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(seen).toEqual([3]);
  });

  it("writes nothing and notifies nobody when the batch changes nothing", async () => {
    const { col, writes } = setup();
    await col.upsertManyDurable([installation("a"), installation("b")]);
    writes.mockClear();
    const listener = vi.fn();
    col.subscribe(listener);

    const changed = await col.upsertManyDurable([
      installation("a"),
      installation("b"),
    ]);

    expect(changed).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not count an explicit undefined as a change", async () => {
    const { adapter, writes } = setup();
    // A row as it comes back from disk: the optional key is absent.
    adapter.write("toolInstallations", JSON.stringify([installation("a")]));
    const db = new Database(adapter);
    writes.mockClear();

    const changed = await db
      .collection("toolInstallations")
      .upsertManyDurable([installation("a", { modifiedAt: undefined })]);

    expect(changed).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });

  it("writes only the rows that changed and keeps the others as they were", async () => {
    const { col, writes } = setup();
    await col.upsertManyDurable([installation("a"), installation("b")]);
    writes.mockClear();

    const changed = await col.upsertManyDurable([
      installation("a"),
      installation("b", { enabled: false, updatedAt: 2 }),
      installation("c"),
    ]);

    expect(changed).toBe(2);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(col.get("b")?.enabled).toBe(false);
    expect(col.getAll().map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("lets the caller decide what counts as a change", async () => {
    const { col, writes } = setup();
    await col.upsertManyDurable([installation("a")]);
    writes.mockClear();

    const changed = await col.upsertManyDurable(
      [installation("a", { updatedAt: 9 })],
      { changed: (existing, next) => existing.version !== next.version },
    );

    expect(changed).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    expect(col.get("a")?.updatedAt).toBe(1);
  });

  it("diffs against the rows as they are when the write runs, not when it was asked", async () => {
    const { col, writes } = setup();
    const first = col.upsertManyDurable([installation("a")]);
    const second = col.upsertManyDurable([installation("a")]);

    expect(await first).toBe(1);
    expect(await second).toBe(0);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("discards a queued batch whose guard no longer holds when its turn comes", async () => {
    const { adapter, col } = setup();
    const gate = deferred();
    adapter.flush = () => gate.promise;
    let current = true;

    const first = col.upsertManyDurable([installation("a")]);
    const second = col.upsertManyDurable([installation("a", { version: "2", updatedAt: 2 })], {
      shouldCommit: () => current,
    });
    current = false;
    gate.resolve();

    expect(await first).toBe(1);
    expect(await second).toBe(0);
    expect(col.get("a")?.version).toBe("1");
  });

  it("publishes nothing when the durable write fails", async () => {
    const { adapter, col } = setup();
    adapter.flush = () => Promise.reject(new Error("disk full"));

    await expect(col.upsertManyDurable([installation("a")])).rejects.toThrow(
      "disk full",
    );
    expect(col.getAll()).toEqual([]);
  });

  it("rejects an invalid record before anything is written", async () => {
    const { col, writes } = setup();

    await expect(
      col.upsertManyDurable([
        installation("a"),
        installation("b", { displayName: "" }),
      ]),
    ).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
    expect(col.getAll()).toEqual([]);
  });
});
