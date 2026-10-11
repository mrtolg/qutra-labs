import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "./storage";
import { QUARANTINE_KEY, quarantine, readQuarantine, type QuarantineEntry } from "./quarantine";

/* A record this version cannot read is kept aside, never erased. */

const entry = (value: unknown, collection = "tasks"): QuarantineEntry => ({
  collection,
  at: 1,
  reason: "invalid_record",
  value,
});

describe("quarantine", () => {
  it("keeps entries and never adds the same record twice", () => {
    const storage = new MemoryStorageAdapter();
    expect(quarantine(storage, [entry({ id: "x" })])).toBe(1);
    expect(quarantine(storage, [entry({ id: "x" }), entry({ id: "y" })])).toBe(1);
    expect(readQuarantine(storage).map((e) => e.value)).toEqual([{ id: "x" }, { id: "y" }]);
  });

  it("keeps an unreadable quarantine as an entry instead of writing over it", () => {
    const storage = new MemoryStorageAdapter();
    storage.write(QUARANTINE_KEY, "{not json");
    quarantine(storage, [entry({ id: "x" })]);
    expect(readQuarantine(storage).map((e) => e.value)).toEqual(["{not json", { id: "x" }]);
  });

  it("writes nothing when there is nothing to keep", () => {
    const storage = new MemoryStorageAdapter();
    expect(quarantine(storage, [])).toBe(0);
    expect(storage.read(QUARANTINE_KEY)).toBeNull();
  });
});
