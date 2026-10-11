import { describe, it, expect } from "vitest";
import {
  evidenceFromRunOutput,
  evidenceFromArtifact,
  evidenceFromText,
  linkEvidenceToFinding,
  unlinkEvidenceFromFinding,
  setEvidenceFindingLink,
  findingsMissingEvidence,
  evidenceCountByFinding,
  EVIDENCE_TEXT_LIMIT,
} from "./evidenceOps";
import { FindingSchema, type Finding } from "@/domain/findings";
import { sha256Hex } from "@/lib/hash";

const T = 1_700_000_000_000;

function finding(id: string, evidenceIds: string[] = []): Finding {
  return FindingSchema.parse({
    id,
    title: `Finding ${id}`,
    fingerprint: `fp-${id}`,
    firstSeen: T,
    lastSeen: T,
    evidenceIds,
    createdAt: T,
    updatedAt: T,
  });
}

describe("evidenceFromRunOutput", () => {
  it("builds a text evidence record linked to run + finding", async () => {
    const ev = await evidenceFromRunOutput({
      runId: "run-1",
      engagementId: "eng-1",
      findingId: "f-1",
      content: "open port 80/tcp",
      stream: "stdout",
      commandPreview: "nmap -sV 127.0.0.1",
      now: T,
    });
    expect(ev.kind).toBe("output");
    expect(ev.findingId).toBe("f-1");
    expect(ev.engagementId).toBe("eng-1");
    expect(ev.runId).toBe("run-1");
    expect(ev.content).toContain("open port 80/tcp");
    expect(ev.source).toBe("run:run-1 (stdout)");
    expect(ev.title).toBe("nmap -sV 127.0.0.1");
    expect(ev.sha256).toBe(await sha256Hex(ev.content));
  });

  it("truncates very large output and marks it", async () => {
    const big = "x".repeat(EVIDENCE_TEXT_LIMIT + 500);
    const ev = await evidenceFromRunOutput({
      runId: "run-2",
      content: big,
      now: T,
    });
    expect(ev.content.length).toBeLessThanOrEqual(EVIDENCE_TEXT_LIMIT + 20);
    expect(ev.content).toContain("[truncated]");
    expect(ev.sha256).toHaveLength(64);
  });
});

describe("evidenceFromText", () => {
  it("does not invent a run relationship for manual evidence", async () => {
    const ev = await evidenceFromText({
      engagementId: "eng-1",
      findingId: "f-1",
      content: "Observed manually",
      now: T,
    });
    expect(ev.kind).toBe("text");
    expect(ev.source).toBe("manual");
    expect(ev.runId).toBeUndefined();
    expect(ev.sha256).toBe(await sha256Hex("Observed manually"));
  });
});

describe("evidenceFromArtifact", () => {
  it("references a path and never inlines content", () => {
    const ev = evidenceFromArtifact({
      runId: "run-3",
      path: "C:/data/lab/runs/run-3/stdout.log",
      kind: "stdout",
      sizeBytes: 2048,
      sha256: "abc",
      now: T,
    });
    expect(ev.content).toBe("");
    expect(ev.path).toContain("stdout.log");
    expect(ev.sha256).toBe("abc");
  });
});

describe("finding ↔ evidence links", () => {
  it("links", () => {
    const f = finding("f-1");
    const patch = linkEvidenceToFinding(f, "ev-1", T + 1);
    expect(patch.evidenceIds).toEqual(["ev-1"]);
    expect(patch.updatedAt).toBe(T + 1);
  });

  it("is idempotent", () => {
    const f = finding("f-1", ["ev-1"]);
    const again = linkEvidenceToFinding(f, "ev-1", T + 2);
    expect(again.evidenceIds).toEqual(["ev-1"]);
    expect(again.updatedAt).toBe(T + 2);
  });

  it("unlinks", () => {
    const f = finding("f-1", ["ev-1", "ev-2"]);
    const patch = unlinkEvidenceFromFinding(f, "ev-1", T + 5);
    expect(patch.evidenceIds).toEqual(["ev-2"]);
  });

  it("reassigns and detaches from the canonical evidence foreign key", async () => {
    const first = finding("f-1", ["ev-1", "stale"]);
    const second = finding("f-2");
    const ev = {
      ...(await evidenceFromRunOutput({
        runId: "r",
        findingId: "f-1",
        content: "proof",
        now: T,
      })),
      id: "ev-1",
    };

    const reassigned = setEvidenceFindingLink(
      [first, second],
      [ev],
      "ev-1",
      "f-2",
      T + 1,
    );
    expect(reassigned.evidence[0].findingId).toBe("f-2");
    expect(
      reassigned.findings.find((item) => item.id === "f-1")?.evidenceIds,
    ).toEqual([]);
    expect(
      reassigned.findings.find((item) => item.id === "f-2")?.evidenceIds,
    ).toEqual(["ev-1"]);

    const detached = setEvidenceFindingLink(
      reassigned.findings,
      reassigned.evidence,
      "ev-1",
      undefined,
      T + 2,
    );
    expect(detached.evidence[0].findingId).toBeUndefined();
    expect(
      detached.findings.every((item) => item.evidenceIds.length === 0),
    ).toBe(true);
  });
});

describe("evidence aggregates", () => {
  it("finds findings missing evidence", async () => {
    const rows = [
      await evidenceFromRunOutput({
        runId: "r",
        findingId: "b",
        content: "a",
        now: T,
      }),
    ];
    const missing = findingsMissingEvidence(
      [finding("a", []), finding("b", []), finding("c", ["stale"])],
      rows,
    );
    expect(missing.map((f) => f.id)).toEqual(["a", "c"]);
  });

  it("counts evidence per finding", async () => {
    const counts = evidenceCountByFinding([
      await evidenceFromRunOutput({
        runId: "r",
        findingId: "f-1",
        content: "a",
        now: T,
      }),
      await evidenceFromRunOutput({
        runId: "r",
        findingId: "f-1",
        content: "b",
        now: T,
      }),
      await evidenceFromRunOutput({
        runId: "r",
        findingId: "f-2",
        content: "c",
        now: T,
      }),
      await evidenceFromRunOutput({
        runId: "r",
        content: "no finding",
        now: T,
      }),
    ]);
    expect(counts.get("f-1")).toBe(2);
    expect(counts.get("f-2")).toBe(1);
    expect(counts.size).toBe(2);
  });
});
