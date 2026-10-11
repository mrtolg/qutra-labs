import { FindingStatus, type Evidence, type Finding } from "@/domain/findings";
import { setEvidenceFindingLink, type EvidenceLinkState } from "@/domain/lab/evidenceOps";

/* The draft rule (spec 2026-10-07 §4.6, D6). A finding no evidence
   row points at is a draft: it shows "Taslak · kanıt yok", cannot be
   confirmed, and stays out of a report. Drafts are counted the way the
   app already counts evidence, by `Evidence.findingId`; `evidenceIds` is
   only its mirror. Lab-only. */

export const FINDING_STATUSES: readonly FindingStatus[] = FindingStatus.options;

/** The history note of a finding that lost its last evidence while confirmed. */
export const UNPROVEN_NOTE = "evidence_removed";

export function isDraft(finding: Pick<Finding, "id">, evidence: readonly Evidence[]): boolean {
  return !evidence.some((item) => item.findingId === finding.id);
}

/** Whether a finding may not move to `status`: confirming needs evidence. */
export function statusBlocked(status: FindingStatus, draft: boolean): boolean {
  return draft && status === "confirmed";
}

/** The finding with its new status, the change kept in its history. */
export function withStatus(
  finding: Finding,
  status: FindingStatus,
  now: number,
  note = "",
): Finding {
  return {
    ...finding,
    status,
    updatedAt: now,
    history: [...finding.history, { at: now, from: finding.status, to: status, note }],
  };
}

/**
 * The confirmed finding that would be left without evidence if this row
 * moved to `target`, or was detached (`target` undefined) or removed.
 */
export function leftUnproven(
  findings: readonly Finding[],
  evidence: readonly Evidence[],
  evidenceId: string,
  target?: string,
): Finding | undefined {
  const item = evidence.find((e) => e.id === evidenceId);
  if (!item?.findingId || item.findingId === target) return undefined;
  const owner = findings.find((f) => f.id === item.findingId);
  if (owner?.status !== "confirmed") return undefined;
  const more = evidence.some((e) => e.id !== evidenceId && e.findingId === owner.id);
  return more ? undefined : owner;
}

/**
 * Move a piece of evidence to `target`, or detach it. A confirmed finding
 * left without evidence goes back to "new", with the reason in its history,
 * so no finding stays confirmed as a draft.
 */
export function relinkEvidence(
  findings: Finding[],
  evidence: Evidence[],
  evidenceId: string,
  target: string | undefined,
  now: number,
): EvidenceLinkState {
  const unproven = leftUnproven(findings, evidence, evidenceId, target);
  const next = setEvidenceFindingLink(findings, evidence, evidenceId, target, now);
  return {
    evidence: next.evidence,
    findings: unproven
      ? next.findings.map((f) => (f.id === unproven.id ? withStatus(f, "new", now, UNPROVEN_NOTE) : f))
      : next.findings,
  };
}
