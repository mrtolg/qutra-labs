import { describe, expect, it } from "vitest";
import {
  dedupeFindings,
  fingerprint,
  importedToFinding,
  manualFinding,
  reimportDiff,
  type ImportContext,
} from "./findingsOps";
import type { ImportedFinding } from "./parsers/types";
import type { Finding } from "@/domain/findings";

const ctx: ImportContext = {
  sourceTool: "semgrep",
  importBatchId: "b1",
  parserVersion: "1.0.0",
  now: 1000,
};

const imp = (over: Partial<ImportedFinding> = {}): ImportedFinding => ({
  title: "SQL Injection",
  severity: "high",
  ruleId: "sqli",
  affectedTargets: ["src/db.ts:42"],
  location: "src/db.ts:42",
  ...over,
});

describe("fingerprint", () => {
  it("is stable and independent of target order", () => {
    const a = fingerprint({ sourceTool: "nmap", ruleId: "r", title: "T", affectedTargets: ["a", "b"] });
    const b = fingerprint({ sourceTool: "NMAP", ruleId: "r", title: "t", affectedTargets: ["b", "a"] });
    expect(a).toBe(b);
  });
  it("differs when the target differs", () => {
    expect(fingerprint({ sourceTool: "t", title: "x", affectedTargets: ["1"] })).not.toBe(
      fingerprint({ sourceTool: "t", title: "x", affectedTargets: ["2"] }),
    );
  });
});

describe("importedToFinding", () => {
  it("derives a stable id from the fingerprint and is schema-valid", () => {
    const f = importedToFinding(imp(), ctx);
    expect(f.id).toBe(`fnd_${f.fingerprint}`);
    expect(f.status).toBe("new");
    expect(f.firstSeen).toBe(1000);
    expect(f.lastSeen).toBe(1000);
    expect(f.sourceTool).toBe("semgrep");
    expect(f.history).toHaveLength(1);
  });

  it("gives the same scan its own rows in each investigation", () => {
    const first = importedToFinding(imp(), { ...ctx, engagementId: "eng_1" });
    const again = importedToFinding(imp(), { ...ctx, engagementId: "eng_1", now: 2000 });
    const other = importedToFinding(imp(), { ...ctx, engagementId: "eng_2" });
    expect(first.id).toBe(again.id);
    expect(first.id).not.toBe(other.id);
    expect(first.fingerprint).toBe(other.fingerprint);
  });
});

describe("dedupeFindings", () => {
  it("merges by fingerprint, widening seen window and targets", () => {
    const a = importedToFinding(imp({ affectedTargets: ["x"] }), { ...ctx, now: 100 });
    const b = importedToFinding(imp({ affectedTargets: ["x"] }), { ...ctx, now: 500 });
    // same fingerprint (title/rule/location identical); different times
    const merged = dedupeFindings([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].firstSeen).toBe(100);
    expect(merged[0].lastSeen).toBe(500);
  });
});

describe("reimportDiff", () => {
  const existing = importedToFinding(imp(), ctx);

  it("classifies created, unchanged, changed, reopened and resolved", () => {
    const other = importedToFinding(imp({ title: "XSS", ruleId: "xss", location: "a.ts:1", affectedTargets: ["a.ts:1"] }), ctx);

    // reimport: same finding unchanged + a brand-new one; `other` disappears
    const incomingUnchanged = importedToFinding(imp(), { ...ctx, now: 2000 });
    const brandNew = importedToFinding(imp({ title: "SSRF", ruleId: "ssrf", location: "b.ts:2", affectedTargets: ["b.ts:2"] }), { ...ctx, now: 2000 });

    const diff = reimportDiff([existing, other], [incomingUnchanged, brandNew]);
    expect(diff.unchanged).toContain(existing.fingerprint);
    expect(diff.created).toContain(brandNew.fingerprint);
    expect(diff.resolved).toContain(other.fingerprint);
  });

  it("detects a changed severity", () => {
    const incoming = importedToFinding(imp({ severity: "critical" }), { ...ctx, now: 2000 });
    const diff = reimportDiff([existing], [incoming]);
    expect(diff.changed).toContain(existing.fingerprint);
  });

  it("reopens a finding that was mitigated then reappears", () => {
    const mitigated: Finding = { ...existing, status: "mitigated" };
    const incoming = importedToFinding(imp(), { ...ctx, now: 2000 });
    const diff = reimportDiff([mitigated], [incoming]);
    expect(diff.reopened).toContain(existing.fingerprint);
  });

  it("preserves an explicit false-positive decision on reimport and absence", () => {
    const fp: Finding = { ...existing, status: "false_positive" };
    const incoming = importedToFinding(imp(), { ...ctx, now: 2000 });
    expect(reimportDiff([fp], [incoming]).preserved).toContain(existing.fingerprint);
    // Also preserved (not resolved) when absent from the incoming set.
    expect(reimportDiff([fp], []).preserved).toContain(existing.fingerprint);
    expect(reimportDiff([fp], []).resolved).not.toContain(existing.fingerprint);
  });
});

describe("manualFinding", () => {
  it("keeps what the tester wrote and never shares a fingerprint with an import", () => {
    const f = manualFinding(
      { title: "  Admin panel open  ", severity: "high", target: " 10.0.0.5 ", description: "" },
      { id: "fnd_a", engagementId: "e1", now: 5 },
    );
    expect(f).toMatchObject({
      id: "fnd_a",
      engagementId: "e1",
      title: "Admin panel open",
      severity: "high",
      status: "new",
      affectedTargets: ["10.0.0.5"],
      sourceTool: "",
      fingerprint: "manual:fnd_a",
      firstSeen: 5,
      lastSeen: 5,
      history: [{ at: 5, to: "new", note: "" }],
    });
    expect(manualFinding({ title: "x", severity: "low" }, { id: "b", engagementId: "e1", now: 1 }).affectedTargets).toEqual([]);
  });
});
