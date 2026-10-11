import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  write: vi.fn<(id: string, name: string, contents: string) => Promise<string>>(),
}));
vi.mock("@/lib/engagementFolders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/engagementFolders")>()),
  engagementFolders: {
    available: () => true,
    get: async () => ({ path: "C:\\Investigations\\Home Lab" }),
    write: files.write,
  },
}));
vi.mock("@/lib/time", () => ({ now: () => 1_760_000_000_000 }));

import { EvidenceSchema, FindingSchema } from "@/domain/findings";
import { EngagementSchema } from "@/domain/lab";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { exportEngagementReport } from "./exportReport";
import { reportWords } from "./reportBuild";

const T = 1_760_000_000_000;
const engagement = EngagementSchema.parse({
  id: "eng-1",
  title: "Home Lab",
  purpose: "training_lab",
  status: "active",
  scopeId: "sc-1",
  createdAt: T,
  updatedAt: T,
});
const words = reportWords((key) => key);

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  getDb()
    .collection("findings")
    .put(
      FindingSchema.parse({
        id: "f-1",
        engagementId: "eng-1",
        title: "Open SSH",
        severity: "high",
        status: "confirmed",
        fingerprint: "fp-1",
        evidenceIds: ["ev-1"],
        firstSeen: T,
        lastSeen: T,
        createdAt: T,
        updatedAt: T,
      }),
    );
  getDb()
    .collection("evidence")
    .put(
      EvidenceSchema.parse({
        id: "ev-1",
        findingId: "f-1",
        engagementId: "eng-1",
        title: "nmap",
        content: "22/tcp open ssh",
        capturedAt: T,
        createdAt: T,
      }),
    );
});

afterEach(() => {
  files.write.mockReset();
  setDbForTesting(null);
});

describe("exporting the report", () => {
  it("keeps a record of the report once its file is saved", async () => {
    files.write.mockResolvedValue("ok");

    const saved = await exportEngagementReport(engagement, "Report", words);

    expect(saved.folder).toBe(true);
    const [record] = getDb().collection("reports").getAll();
    expect(record).toMatchObject({ engagementId: "eng-1", includedFindingIds: ["f-1"] });
  });

  it("leaves no record behind when the file cannot be written", async () => {
    files.write.mockRejectedValue(new Error("disk full"));

    await expect(exportEngagementReport(engagement, "Report", words)).rejects.toThrow("disk full");

    expect(getDb().collection("reports").getAll()).toEqual([]);
  });
});
