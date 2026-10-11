import { describe, expect, it } from "vitest";
import type { Engagement } from "@/domain/lab";
import type { Finding } from "@/domain/findings";
import type { EngagementScopeStatus } from "@/domain/lab/scope";
import type { NativeToolRun } from "@/lib/bridge/types";
import {
  attentionItems,
  openFindingsByEngagement,
  severityWeight,
  totalOf,
} from "./investigationFacts";

const NOW = 1_800_000_000_000;

const eng = (id: string, status: Engagement["status"] = "active"): Engagement =>
  ({ id, title: id, status, createdAt: NOW, updatedAt: NOW }) as Engagement;

const finding = (
  engagementId: string,
  severity: Finding["severity"],
  status: Finding["status"] = "new",
): Finding => ({ id: `${engagementId}-${severity}-${status}`, engagementId, severity, status }) as Finding;

const scopes = (entries: [string, EngagementScopeStatus["status"], number?][]) =>
  new Map<string, EngagementScopeStatus>(
    entries.map(([id, status, outOfScopeCount = 0]) => [id, { status, outOfScopeCount }]),
  );

describe("open findings", () => {
  it("counts only findings still to deal with, by severity", () => {
    const counts = openFindingsByEngagement([
      finding("a", "critical"),
      finding("a", "high", "confirmed"),
      finding("a", "high", "false_positive"),
      finding("a", "low", "verified"),
      finding("b", "medium", "reopened"),
    ]);
    expect(counts.get("a")).toEqual({ critical: 1, high: 1, medium: 0, low: 0, info: 0 });
    expect(totalOf(counts.get("b"))).toBe(1);
    expect(totalOf(counts.get("none"))).toBe(0);
  });

  it("weighs one critical above many highs", () => {
    const one = { critical: 1, high: 0, medium: 0, low: 0, info: 0 };
    const many = { critical: 0, high: 40, medium: 0, low: 0, info: 0 };
    expect(severityWeight(one)).toBeGreaterThan(severityWeight(many));
  });
});

describe("what needs attention", () => {
  it("puts blocked runs and critical findings before scope gaps", () => {
    const items = attentionItems({
      engagements: [eng("scopeless"), eng("blocked"), eng("critical")],
      findings: [finding("critical", "critical"), finding("critical", "high")],
      scopeStatus: scopes([
        ["scopeless", "not_configured"],
        ["blocked", "target_out_of_scope", 2],
        ["critical", "validated"],
      ]),
      runs: [],
      now: NOW,
    });
    expect(items.map((i) => [i.kind, i.engagement?.id])).toEqual([
      ["blocked", "blocked"],
      ["findings", "critical"],
      ["scope", "scopeless"],
    ]);
    expect(items[0]).toMatchObject({ count: 2, tone: "danger" });
    expect(items[1]).toMatchObject({ count: 2, tone: "danger" });
  });

  it("asks nothing of archived, completed or planned work", () => {
    const items = attentionItems({
      engagements: [eng("old", "archived"), eng("done", "completed"), eng("later", "planned")],
      findings: [finding("old", "critical"), finding("done", "critical")],
      scopeStatus: scopes([
        ["old", "target_out_of_scope", 1],
        ["done", "validated"],
        ["later", "not_configured"],
      ]),
      runs: [],
      now: NOW,
    });
    expect(items).toEqual([]);
  });

  it("names reviewed or medium findings as nothing to do", () => {
    const items = attentionItems({
      engagements: [eng("a")],
      findings: [finding("a", "high", "confirmed"), finding("a", "medium")],
      scopeStatus: scopes([["a", "validated"]]),
      runs: [],
      now: NOW,
    });
    expect(items).toEqual([]);
  });

  it("keeps a failed run for a day", () => {
    const run = (id: string, state: NativeToolRun["state"], endedAt: number) =>
      ({ id, state, endedAt, updatedAt: endedAt, engagementId: "a" }) as NativeToolRun;
    const items = attentionItems({
      engagements: [eng("a")],
      findings: [],
      scopeStatus: scopes([["a", "validated"]]),
      runs: [
        run("fresh", "failed", NOW - 60_000),
        run("stale", "timed_out", NOW - 2 * 24 * 3600_000),
        run("fine", "succeeded", NOW),
      ],
      now: NOW,
    });
    expect(items.map((i) => (i.kind === "failedRun" ? i.run.id : i.kind))).toEqual(["fresh"]);
  });
});
