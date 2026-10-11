import { describe, expect, it } from "vitest";
import { FindingSchema, EvidenceSchema } from "@/domain/findings";
import {
  UNPROVEN_NOTE,
  isDraft,
  leftUnproven,
  relinkEvidence,
  statusBlocked,
  withStatus,
} from "./findingDraft";

/* A finding without evidence is a draft and cannot be confirmed. */

const finding = FindingSchema.parse({
  id: "fnd_1",
  engagementId: "eng_1",
  title: "Open port",
  severity: "low",
  status: "new",
  fingerprint: "manual:fnd_1",
  firstSeen: 1,
  lastSeen: 1,
  history: [{ at: 1, to: "new" }],
  createdAt: 1,
  updatedAt: 1,
});

const evidence = (findingId?: string) =>
  EvidenceSchema.parse({ id: "ev_1", findingId, title: "Output", capturedAt: 1, createdAt: 1 });

describe("the draft rule", () => {
  it("is a draft until an evidence row points at it", () => {
    expect(isDraft(finding, [])).toBe(true);
    expect(isDraft(finding, [evidence("fnd_2")])).toBe(true);
    expect(isDraft(finding, [evidence("fnd_1")])).toBe(false);
  });

  it("blocks only confirming a draft", () => {
    expect(statusBlocked("confirmed", true)).toBe(true);
    expect(statusBlocked("false_positive", true)).toBe(false);
    expect(statusBlocked("confirmed", false)).toBe(false);
  });

  it("keeps a status change in the history", () => {
    const next = withStatus(finding, "in_progress", 9);
    expect(next.status).toBe("in_progress");
    expect(next.updatedAt).toBe(9);
    expect(next.history.at(-1)).toEqual({ at: 9, from: "new", to: "in_progress", note: "" });
  });
});

describe("moving evidence", () => {
  const confirmed = { ...finding, status: "confirmed" as const, evidenceIds: ["ev_1"] };
  const other = FindingSchema.parse({ ...finding, id: "fnd_2", fingerprint: "manual:fnd_2" });
  const row = (id: string, findingId?: string) =>
    EvidenceSchema.parse({ id, findingId, title: id, capturedAt: 1, createdAt: 1 });

  it("names a confirmed finding that would lose its last evidence", () => {
    const rows = [row("ev_1", "fnd_1")];
    expect(leftUnproven([confirmed, other], rows, "ev_1", "fnd_2")?.id).toBe("fnd_1");
    expect(leftUnproven([confirmed, other], rows, "ev_1")?.id).toBe("fnd_1");
    // It keeps other evidence, it stays where it is, or it is not confirmed.
    expect(leftUnproven([confirmed], [...rows, row("ev_2", "fnd_1")], "ev_1")).toBeUndefined();
    expect(leftUnproven([confirmed], rows, "ev_1", "fnd_1")).toBeUndefined();
    expect(leftUnproven([{ ...confirmed, status: "new" }], rows, "ev_1")).toBeUndefined();
  });

  it("sends a confirmed finding left without evidence back to new, saying why", () => {
    const next = relinkEvidence([confirmed, other], [row("ev_1", "fnd_1")], "ev_1", "fnd_2", 9);
    expect(next.evidence[0]!.findingId).toBe("fnd_2");
    const left = next.findings.find((f) => f.id === "fnd_1")!;
    expect(left).toMatchObject({ status: "new", evidenceIds: [] });
    expect(left.history.at(-1)).toEqual({ at: 9, from: "confirmed", to: "new", note: UNPROVEN_NOTE });
    expect(next.findings.find((f) => f.id === "fnd_2")!.evidenceIds).toEqual(["ev_1"]);
  });
});
