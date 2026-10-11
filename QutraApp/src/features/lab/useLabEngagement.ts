import { useMemo } from "react";
import { useCollection, usePreferences } from "@/lib/db/database";
import { useLabRuntime } from "@/state/labRuntime";
import type { LabView } from "@/domain/workbench";

const ACTIVE_STATES = ["queued", "starting", "running", "cancelling"];

export type RunsState = "known" | "reading" | "failed" | "hidden";

/**
 * The engagement the Lab shows for a URL's `e` (the one worked on last when
 * the URL names none), with its targets, its active runs and the counts beside the
 * Lab's views. The Lab surface and the Lab's sub-tabs both read it, so the
 * header and the tabs never count different things.
 */
export function useLabEngagement(openId: string | null) {
  const engagements = useCollection("engagements");
  const targets = useCollection("targets");
  const findings = useCollection("findings");
  const evidence = useCollection("evidence");
  const runtime = useLabRuntime();
  const consented = usePreferences().privateToolsEnabled;

  // With none named, or one that no longer exists, the one worked on last;
  // archived ones only if nothing else is left.
  const named = openId ? engagements.find((e) => e.id === openId) : undefined;
  const current =
    named ??
    [...engagements]
      .filter((e) => e.status !== "archived")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
    engagements[0];
  const engTargets = useMemo(
    () => (current ? targets.filter((tg) => tg.engagementId === current.id) : []),
    [targets, current],
  );
  /* The browser build cannot run tools, so there zero is the truth. In the
     desktop app the count is a fact only after a good read with Private Lab
     consent: withdrawing consent gates listing but stops nothing (same rule
     as Home), so it never reads as "0 active runs". */
  const runsState: RunsState = !runtime.available
    ? "known"
    : !consented
      ? "hidden"
      : runtime.readFailed
        ? "failed"
        : runtime.ready
          ? "known"
          : "reading";
  // A live run of an outside program counts and stops with the rest, by id.
  const activeRuns: { id: string }[] =
    runsState === "known"
      ? [
          ...runtime.runs.filter(
            (r) => current && r.engagementId === current.id && ACTIVE_STATES.includes(r.state),
          ),
          ...runtime.outsideLive.filter((r) => current && r.engagementId === current.id),
        ]
      : [];
  const counts: Partial<Record<LabView, number>> = current
    ? {
        targets: engTargets.length,
        runs: activeRuns.length,
        findings: findings.filter((f) => f.engagementId === current.id).length,
        evidence: evidence.filter((e) => e.engagementId === current.id).length,
      }
    : {};

  return { engagements, current, engTargets, runsState, activeRuns, counts };
}
