import type { AuthorizationScope, Engagement, Target } from "@/domain/lab";
import type { Finding, FindingStatus, Severity } from "@/domain/findings";
import { engagementScopeStatus, type EngagementScopeStatus } from "@/domain/lab/scope";
import type { NativeToolRun } from "@/lib/bridge/types";

/* Facts about investigations that Home and the Investigations list both show:
   open findings by severity, the scope's state, and what needs the user now.
   Everything here is derived from records the app already keeps; nothing is
   estimated. */

/** A finding still to be dealt with: not fixed, not dismissed. */
const OPEN_FINDING = new Set<FindingStatus>(["new", "confirmed", "in_progress", "reopened"]);
/** A finding nobody has looked at yet (new, or back after a fix). */
const UNREVIEWED = new Set<FindingStatus>(["new", "reopened"]);

/** Most severe first, the order every summary uses. */
export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

export type SeverityCounts = Record<Severity, number>;

const emptyCounts = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

export function isOpenFinding(f: Pick<Finding, "status">): boolean {
  return OPEN_FINDING.has(f.status);
}

/** Open findings per investigation, by severity. */
export function openFindingsByEngagement(findings: readonly Finding[]): Map<string, SeverityCounts> {
  const out = new Map<string, SeverityCounts>();
  for (const f of findings) {
    if (!f.engagementId || !isOpenFinding(f)) continue;
    const counts = out.get(f.engagementId) ?? emptyCounts();
    counts[f.severity] += 1;
    out.set(f.engagementId, counts);
  }
  return out;
}

export function totalOf(counts: SeverityCounts | undefined): number {
  return counts ? SEVERITY_ORDER.reduce((sum, s) => sum + counts[s], 0) : 0;
}

/** A sort key that puts one critical above any number of highs, and so on. */
export function severityWeight(counts: SeverityCounts | undefined): number {
  if (!counts) return 0;
  return (
    counts.critical * 1e8 + counts.high * 1e6 + counts.medium * 1e4 + counts.low * 1e2 + counts.info
  );
}

/** The scope state of every investigation, by id. */
export function scopeStatusByEngagement(
  engagements: readonly Engagement[],
  scopes: readonly AuthorizationScope[],
  targets: readonly Target[],
  now = Date.now(),
): Map<string, EngagementScopeStatus> {
  const out = new Map<string, EngagementScopeStatus>();
  for (const e of engagements) {
    const scope = e.scopeId ? scopes.find((s) => s.id === e.scopeId) : undefined;
    const own = targets.filter((t) => t.engagementId === e.id);
    out.set(e.id, engagementScopeStatus(scope, own, now));
  }
  return out;
}

export type AttentionTone = "danger" | "warning" | "info";

export type AttentionItem =
  | { kind: "blocked"; tone: "danger"; engagement: Engagement; count: number }
  | {
      kind: "findings";
      tone: "danger" | "warning";
      engagement: Engagement;
      count: number;
    }
  | {
      kind: "scope";
      tone: "info";
      engagement: Engagement;
      reason: "not_configured" | "acknowledgement_required";
    }
  | { kind: "failedRun"; tone: "warning"; engagement: Engagement | undefined; run: NativeToolRun };

const TONE_RANK: Record<AttentionTone, number> = { danger: 0, warning: 1, info: 2 };
const FAILED_RUN = new Set<NativeToolRun["state"]>(["failed", "timed_out"]);
/** A failed run stays on Home for a day; after that it is history. */
const FAILED_RUN_WINDOW = 24 * 60 * 60 * 1000;

/**
 * What needs the user now, most urgent first:
 * - runs are blocked because a target is out of scope;
 * - important (critical or high) findings nobody has reviewed;
 * - a run that failed in the last day;
 * - an investigation under way whose scope is not set yet.
 * Archived and completed investigations ask for nothing.
 */
export function attentionItems({
  engagements,
  findings,
  scopeStatus,
  runs,
  now = Date.now(),
}: {
  engagements: readonly Engagement[];
  findings: readonly Finding[];
  scopeStatus: Map<string, EngagementScopeStatus>;
  /** Finished native runs, only when they are known. */
  runs: readonly NativeToolRun[];
  now?: number;
}): AttentionItem[] {
  const live = engagements.filter((e) => e.status !== "archived" && e.status !== "completed");
  const items: AttentionItem[] = [];
  for (const e of live) {
    const scope = scopeStatus.get(e.id);
    if (scope?.status === "target_out_of_scope") {
      items.push({ kind: "blocked", tone: "danger", engagement: e, count: scope.outOfScopeCount });
    }
    const important = findings.filter(
      (f) =>
        f.engagementId === e.id &&
        UNREVIEWED.has(f.status) &&
        (f.severity === "critical" || f.severity === "high"),
    );
    if (important.length > 0) {
      items.push({
        kind: "findings",
        tone: important.some((f) => f.severity === "critical") ? "danger" : "warning",
        engagement: e,
        count: important.length,
      });
    }
    // Planned and paused ones wait for the user anyway; only work under way
    // without a scope is a problem now.
    if (
      e.status === "active" &&
      (scope?.status === "not_configured" || scope?.status === "acknowledgement_required")
    ) {
      items.push({ kind: "scope", tone: "info", engagement: e, reason: scope.status });
    }
  }
  for (const run of runs) {
    if (!FAILED_RUN.has(run.state)) continue;
    const ended = run.endedAt ?? run.updatedAt;
    if (now - ended > FAILED_RUN_WINDOW) continue;
    const engagement = run.engagementId
      ? engagements.find((e) => e.id === run.engagementId)
      : undefined;
    if (engagement?.status === "archived") continue;
    items.push({ kind: "failedRun", tone: "warning", engagement, run });
  }
  // Stable: within a tone, the order above (investigations newest first).
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => TONE_RANK[a.item.tone] - TONE_RANK[b.item.tone] || a.i - b.i)
    .map(({ item }) => item);
}
