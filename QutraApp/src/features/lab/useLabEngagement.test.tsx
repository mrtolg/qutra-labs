import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { createEngagement } from "@/services/appService";
import { useLabEngagement } from "./useLabEngagement";

/* Which investigation the Lab shows for the address it was opened with. */

afterEach(() => setDbForTesting(null));

function seed() {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  const first = createEngagement("First", "web");
  const second = createEngagement("Second", "pcap");
  getDb().collection("engagements").patch(second, { updatedAt: Date.now() + 10_000 });
  return { first, second };
}

describe("useLabEngagement", () => {
  it("shows the one the address names", () => {
    const { first } = seed();
    const { result } = renderHook(() => useLabEngagement(first));
    expect(result.current.current?.id).toBe(first);
  });

  it("shows the one worked on last when the address names none", () => {
    const { second } = seed();
    const { result } = renderHook(() => useLabEngagement(null));
    expect(result.current.current?.id).toBe(second);
  });

  it("does not claim there is no investigation when the named one is gone", () => {
    const { second } = seed();
    const { result } = renderHook(() => useLabEngagement("eng-that-was-removed"));
    expect(result.current.current?.id).toBe(second);
  });
});
