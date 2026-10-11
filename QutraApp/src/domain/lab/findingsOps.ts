import { FindingSchema, type Finding, type Severity } from "@/domain/findings";
import type { ImportedFinding } from "./parsers/types";

/* ============================================================
   Finding normalization: stable fingerprints, deduplication and
   reimport comparison (new/unchanged/changed/resolved/reopened).
   Pure and deterministic so ingestion is testable and idempotent.
   ============================================================ */

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h >>>= 0;
  }
  return h.toString(36);
}

export interface FingerprintInput {
  sourceTool: string;
  ruleId?: string;
  title: string;
  affectedTargets?: string[];
  location?: string;
}

/** A stable identity for a finding across reimports of the same tool. */
export function fingerprint(input: FingerprintInput): string {
  const key = [
    input.sourceTool.trim().toLowerCase(),
    (input.ruleId ?? "").trim().toLowerCase(),
    input.title.trim().toLowerCase(),
    [...(input.affectedTargets ?? [])].map((t) => t.trim().toLowerCase()).sort().join(","),
    (input.location ?? "").trim().toLowerCase(),
  ].join("|");
  return `fp_${djb2(key)}`;
}

export interface ImportContext {
  sourceTool: string;
  sourceRunId?: string;
  engagementId?: string;
  importBatchId: string;
  parserVersion: string;
  now: number;
}

/** Build a persisted Finding from a parsed one. The id is derived from the
    fingerprint and the investigation, so the same logical finding keeps its
    id across reimports, and the same scan imported into two investigations
    makes two rows instead of moving one. */
export function importedToFinding(imp: ImportedFinding, ctx: ImportContext): Finding {
  const fp = fingerprint({
    sourceTool: ctx.sourceTool,
    ruleId: imp.ruleId,
    title: imp.title,
    affectedTargets: imp.affectedTargets,
    location: imp.location,
  });
  return FindingSchema.parse({
    id: ctx.engagementId ? `fnd_${fp}_${djb2(ctx.engagementId)}` : `fnd_${fp}`,
    engagementId: ctx.engagementId,
    title: imp.title,
    description: imp.description ?? "",
    severity: imp.severity,
    status: "new",
    affectedTargets: imp.affectedTargets ?? [],
    sourceTool: ctx.sourceTool,
    sourceRunId: ctx.sourceRunId,
    ruleId: imp.ruleId ?? "",
    location: imp.location ?? "",
    fingerprint: fp,
    firstSeen: ctx.now,
    lastSeen: ctx.now,
    cwe: imp.cwe ?? [],
    cve: imp.cve ?? [],
    references: imp.references ?? [],
    importBatchId: ctx.importBatchId,
    parserVersion: ctx.parserVersion,
    history: [{ at: ctx.now, to: "new", note: "imported" }],
    demo: false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
}

/** A finding the tester writes down themselves. Its fingerprint is its own
    id, so a later import never merges a scanner's finding into it. */
export function manualFinding(
  input: { title: string; severity: Severity; target?: string; description?: string },
  ctx: { id: string; engagementId: string; now: number },
): Finding {
  const target = input.target?.trim() ?? "";
  return FindingSchema.parse({
    id: ctx.id,
    engagementId: ctx.engagementId,
    title: input.title.trim(),
    description: input.description?.trim() ?? "",
    severity: input.severity,
    status: "new",
    affectedTargets: target ? [target] : [],
    fingerprint: `manual:${ctx.id}`,
    firstSeen: ctx.now,
    lastSeen: ctx.now,
    history: [{ at: ctx.now, to: "new" }],
    demo: false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
}

/** Merge findings that share a fingerprint (union targets, widen the seen
    window). Keeps the first title/description encountered. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byFp = new Map<string, Finding>();
  for (const f of findings) {
    const existing = byFp.get(f.fingerprint);
    if (!existing) {
      byFp.set(f.fingerprint, { ...f });
      continue;
    }
    existing.firstSeen = Math.min(existing.firstSeen, f.firstSeen);
    existing.lastSeen = Math.max(existing.lastSeen, f.lastSeen);
    existing.affectedTargets = [
      ...new Set([...existing.affectedTargets, ...f.affectedTargets]),
    ];
  }
  return [...byFp.values()];
}

/** User decisions that must survive a reimport untouched. */
const PRESERVED_STATUSES = new Set<Finding["status"]>([
  "false_positive",
  "risk_accepted",
  "out_of_scope",
  "duplicate",
]);

/** Statuses meaning the finding was considered handled; reappearance reopens. */
const FIXED_STATUSES = new Set<Finding["status"]>(["mitigated", "verified"]);

export interface ReimportDiff {
  /** Fingerprints present in the incoming set but not in existing. */
  created: string[];
  /** Existing fingerprints that were fixed and reappeared. */
  reopened: string[];
  /** Existing fingerprints whose severity or description changed. */
  changed: string[];
  /** Existing fingerprints seen again unchanged (lastSeen bump only). */
  unchanged: string[];
  /** Existing fingerprints absent from the incoming set. */
  resolved: string[];
  /** Existing fingerprints whose explicit user decision was preserved. */
  preserved: string[];
}

/**
 * Compare an incoming import against existing findings by fingerprint.
 * Explicit user decisions (false-positive, risk-accepted, out-of-scope,
 * duplicate) are preserved and never reopened or marked resolved.
 */
export function reimportDiff(
  existing: Finding[],
  incoming: Finding[],
): ReimportDiff {
  const existingByFp = new Map(existing.map((f) => [f.fingerprint, f]));
  const incomingByFp = new Map(incoming.map((f) => [f.fingerprint, f]));

  const diff: ReimportDiff = {
    created: [],
    reopened: [],
    changed: [],
    unchanged: [],
    resolved: [],
    preserved: [],
  };

  for (const inc of incoming) {
    const prev = existingByFp.get(inc.fingerprint);
    if (!prev) {
      diff.created.push(inc.fingerprint);
      continue;
    }
    if (PRESERVED_STATUSES.has(prev.status)) {
      diff.preserved.push(inc.fingerprint);
      continue;
    }
    if (FIXED_STATUSES.has(prev.status)) {
      diff.reopened.push(inc.fingerprint);
      continue;
    }
    if (prev.severity !== inc.severity || prev.description !== inc.description) {
      diff.changed.push(inc.fingerprint);
    } else {
      diff.unchanged.push(inc.fingerprint);
    }
  }

  for (const prev of existing) {
    if (incomingByFp.has(prev.fingerprint)) continue;
    if (PRESERVED_STATUSES.has(prev.status)) {
      diff.preserved.push(prev.fingerprint);
      continue;
    }
    diff.resolved.push(prev.fingerprint);
  }

  return diff;
}
