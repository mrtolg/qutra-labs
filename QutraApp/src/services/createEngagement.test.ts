import { afterEach, describe, expect, it } from "vitest";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { createEngagement } from "@/services/appService";

afterEach(() => setDbForTesting(null));

describe("createEngagement", () => {
  it("records the kind when one is chosen and none otherwise", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const photo = createEngagement("Photo", "file");
    const plain = createEngagement("Plain");
    expect(getDb().collection("engagements").get(photo)?.kind).toBe("file");
    expect(getDb().collection("engagements").get(plain)?.kind).toBeUndefined();
  });
});
