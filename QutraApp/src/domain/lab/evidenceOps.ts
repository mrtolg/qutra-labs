/* ============================================================
   Evidence operations (pure).

   Evidence is a first-class record, distinct from a Finding: a run's
   output slice, an artifact file, a screenshot reference or free text that
   substantiates a Finding. These helpers build Evidence records and wire the
   bidirectional Finding↔Evidence link without touching storage, so they are
   unit-testable and reused by the Lab UI.

   Large binary payloads are never inlined here — file/screenshot evidence
   carries a path/reference, and captured text is bounded by the caller.
   ============================================================ */

import type { Evidence, Finding } from "@/domain/findings";
import { EvidenceSchema } from "@/domain/findings";
import { sha256Hex } from "@/lib/hash";
import { createId } from "@/lib/id";

async function contentDigest(content: string): Promise<string> {
  return content ? sha256Hex(content) : "";
}

/** Bytes of run output copied into a text-evidence record. Beyond this we
    keep a reference rather than inlining the whole stream. */
export const EVIDENCE_TEXT_LIMIT = 32 * 1024;

export interface RunEvidenceInput {
  runId: string;
  engagementId?: string;
  findingId?: string;
  targetId?: string;
  /** stdout / stderr slice the user selected (or the tail). */
  content: string;
  stream?: "stdout" | "stderr";
  commandPreview?: string;
  now: number;
}

/** Build a text Evidence record from a selected slice of run output. */
export async function evidenceFromRunOutput(
  input: RunEvidenceInput,
): Promise<Evidence> {
  const trimmed = input.content.slice(0, EVIDENCE_TEXT_LIMIT);
  const truncated = input.content.length > EVIDENCE_TEXT_LIMIT;
  const streamLabel = input.stream ? ` (${input.stream})` : "";
  const content = truncated ? `${trimmed}\n…[truncated]` : trimmed;
  return EvidenceSchema.parse({
    id: createId("ev"),
    findingId: input.findingId,
    engagementId: input.engagementId,
    runId: input.runId,
    targetId: input.targetId,
    kind: "output",
    title:
      input.commandPreview?.slice(0, 120) ||
      `Run output ${input.runId}${streamLabel}`,
    content,
    path: "",
    sha256: await contentDigest(content),
    capturedAt: input.now,
    source: `run:${input.runId}${streamLabel}`,
    sensitivity: "normal",
    includeInReport: true,
    demo: false,
    createdAt: input.now,
  });
}

export interface ArtifactEvidenceInput {
  runId: string;
  engagementId?: string;
  findingId?: string;
  targetId?: string;
  path: string;
  kind: "stdout" | "stderr" | "file";
  sizeBytes: number;
  sha256?: string;
  now: number;
}

/** Build a file/artifact Evidence record that references a path, not content. */
export function evidenceFromArtifact(input: ArtifactEvidenceInput): Evidence {
  const name = input.path.split(/[\\/]/).pop() || input.path;
  return EvidenceSchema.parse({
    id: createId("ev"),
    findingId: input.findingId,
    engagementId: input.engagementId,
    runId: input.runId,
    targetId: input.targetId,
    kind: input.kind === "file" ? "file" : "artifact",
    title: `${name} · run ${input.runId}`,
    content: "",
    path: input.path,
    sha256: input.sha256 ?? "",
    capturedAt: input.now,
    source: `run:${input.runId}`,
    sensitivity: "normal",
    includeInReport: true,
    demo: false,
    createdAt: input.now,
  });
}

export interface TextEvidenceInput {
  engagementId?: string;
  findingId?: string;
  targetId?: string;
  title?: string;
  content: string;
  now: number;
}

/** Build evidence entered by a person without inventing a native run link. */
export async function evidenceFromText(
  input: TextEvidenceInput,
): Promise<Evidence> {
  const content = input.content.slice(0, EVIDENCE_TEXT_LIMIT);
  return EvidenceSchema.parse({
    id: createId("ev"),
    findingId: input.findingId,
    engagementId: input.engagementId,
    targetId: input.targetId,
    kind: "text",
    title: input.title?.trim() || content.split(/\r?\n/, 1)[0].slice(0, 120),
    content,
    path: "",
    sha256: await contentDigest(content),
    capturedAt: input.now,
    source: "manual",
    sensitivity: "normal",
    includeInReport: true,
    demo: false,
    createdAt: input.now,
  });
}

/** Attach an evidence id to a finding (idempotent), returning the patch. */
export function linkEvidenceToFinding(
  finding: Finding,
  evidenceId: string,
  now: number,
): Pick<Finding, "evidenceIds" | "updatedAt"> {
  const evidenceIds = finding.evidenceIds.includes(evidenceId)
    ? finding.evidenceIds
    : [...finding.evidenceIds, evidenceId];
  return { evidenceIds, updatedAt: now };
}

/** Remove an evidence id from a finding, returning the patch. */
export function unlinkEvidenceFromFinding(
  finding: Finding,
  evidenceId: string,
  now: number,
): Pick<Finding, "evidenceIds" | "updatedAt"> {
  return {
    evidenceIds: finding.evidenceIds.filter((id) => id !== evidenceId),
    updatedAt: now,
  };
}

/** Findings with no attached evidence — surfaced on the Lab overview. */
export interface EvidenceLinkState {
  findings: Finding[];
  evidence: Evidence[];
}

/**
 * Set or clear an Evidence-to-Finding relationship and rebuild every mirrored
 * Finding.evidenceIds array from the canonical Evidence.findingId foreign key.
 */
export function setEvidenceFindingLink(
  findings: Finding[],
  evidence: Evidence[],
  evidenceId: string,
  findingId: string | undefined,
  updatedAt: number,
): EvidenceLinkState {
  if (!evidence.some((item) => item.id === evidenceId)) {
    throw new Error("evidence_not_found");
  }
  if (findingId && !findings.some((item) => item.id === findingId)) {
    throw new Error("finding_not_found");
  }

  const nextEvidence = evidence.map((item) =>
    item.id === evidenceId ? { ...item, findingId } : item,
  );
  const idsByFinding = new Map<string, string[]>();
  for (const item of nextEvidence) {
    if (!item.findingId) continue;
    const ids = idsByFinding.get(item.findingId) ?? [];
    if (!ids.includes(item.id)) ids.push(item.id);
    idsByFinding.set(item.findingId, ids);
  }

  const nextFindings = findings.map((finding) => {
    const evidenceIds = idsByFinding.get(finding.id) ?? [];
    const unchanged =
      evidenceIds.length === finding.evidenceIds.length &&
      evidenceIds.every((id, index) => id === finding.evidenceIds[index]);
    return unchanged ? finding : { ...finding, evidenceIds, updatedAt };
  });
  return { findings: nextFindings, evidence: nextEvidence };
}

export function findingsMissingEvidence(
  findings: Finding[],
  evidence?: Evidence[],
): Finding[] {
  if (!evidence) return findings.filter((f) => f.evidenceIds.length === 0);
  const counts = evidenceCountByFinding(evidence);
  return findings.filter((finding) => (counts.get(finding.id) ?? 0) === 0);
}

/** Count evidence per finding id, for dense list columns. */
export function evidenceCountByFinding(evidence: Evidence[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ev of evidence) {
    if (!ev.findingId) continue;
    counts.set(ev.findingId, (counts.get(ev.findingId) ?? 0) + 1);
  }
  return counts;
}
