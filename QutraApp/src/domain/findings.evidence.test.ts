import { describe, expect, it } from "vitest";
import { EvidenceSchema } from "./findings";

/* Evidence can be an observation of a built-in analysis. The
   change is additive: rows written before it load unchanged. */

const base = {
  id: "ev_1",
  title: "Run output",
  capturedAt: 1,
  createdAt: 1,
};

describe("evidence rows", () => {
  it("loads a row written before observations existed, unchanged", () => {
    const old = { ...base, kind: "output", content: "nmap …", sha256: "ab", runId: "run-1" };
    const parsed = EvidenceSchema.parse(old);
    expect(parsed).toMatchObject(old);
    expect(parsed.observationIds).toBeUndefined();
    expect(parsed.rawRef).toBeUndefined();
  });

  it("keeps an observation's run, file, ids and raw output reference", () => {
    const row = {
      ...base,
      kind: "observation",
      runId: "ana-00000000-0000-4000-8000-000000000001",
      fileId: "file_1",
      observationIds: ["ana-00000000-0000-4000-8000-000000000001:3"],
      rawRef: { relPath: "analysis/ana-1/output.txt", sha256: "cd".repeat(32) },
    };
    expect(EvidenceSchema.parse(row)).toMatchObject(row);
  });
});
