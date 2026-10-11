import { describe, expect, it } from "vitest";
import {
  normalizeProfile,
  normalizeRepo,
  normalizeContributionCalendar,
  contributionLevel,
  withLevels,
  computeContributionStats,
  toWeeks,
  groupSearchResults,
  shouldQueryRemote,
  type GhSearchResult,
} from "./github";

describe("normalization", () => {
  it("maps a profile and coerces missing fields to null/0", () => {
    const p = normalizeProfile({ login: "mert", avatar_url: "a", followers: 12, name: null });
    expect(p).toMatchObject({ login: "mert", avatarUrl: "a", followers: 12, name: null, bio: null });
  });

  it("maps a repo including owner and pushed_at", () => {
    const r = normalizeRepo({
      id: 5,
      name: "contextos",
      full_name: "mert/contextos",
      owner: { login: "mert" },
      stargazers_count: 3,
      private: true,
      pushed_at: "2026-07-01T00:00:00Z",
      default_branch: "main",
    });
    expect(r).toMatchObject({ id: 5, owner: "mert", stars: 3, private: true });
    expect(r.pushedAt).toBe(Date.parse("2026-07-01T00:00:00Z"));
    expect(r.language).toBeNull();
  });
});

describe("contribution calendar", () => {
  it("buckets counts into 0..4 relative to the max", () => {
    expect(contributionLevel(0, 10)).toBe(0);
    expect(contributionLevel(1, 10)).toBe(1);
    expect(contributionLevel(3, 10)).toBe(2);
    expect(contributionLevel(6, 10)).toBe(3);
    expect(contributionLevel(10, 10)).toBe(4);
    // Any activity with an unknown max is at least level 1.
    expect(contributionLevel(2, 0)).toBe(1);
  });

  it("flattens GraphQL contributionCalendar weeks", () => {
    const days = normalizeContributionCalendar({
      weeks: [
        {
          contributionDays: [
            { date: "2026-07-01", contributionCount: 4 },
            { date: "2026-07-02", contributionCount: 0 },
          ],
        },
      ],
    });
    expect(days).toEqual([
      { date: "2026-07-01", count: 4, level: 4 },
      { date: "2026-07-02", count: 0, level: 0 },
    ]);
    expect(normalizeContributionCalendar(null)).toEqual([]);
  });

  it("computes honest totals, active days, and streaks", () => {
    const days = [
      { date: "2026-07-01", count: 0 },
      { date: "2026-07-02", count: 2 },
      { date: "2026-07-03", count: 3 },
      { date: "2026-07-04", count: 0 },
      { date: "2026-07-05", count: 1 },
      { date: "2026-07-06", count: 4 },
    ];
    const s = computeContributionStats(days);
    expect(s.total).toBe(10);
    expect(s.activeDays).toBe(4);
    expect(s.longestStreak).toBe(2); // 07-05..07-06 and 07-02..07-03 both 2
    expect(s.currentStreak).toBe(2); // trailing 07-05, 07-06
    expect(s.maxInDay).toBe(4);
  });

  it("reports a broken current streak when the last day is empty", () => {
    const s = computeContributionStats([
      { date: "2026-07-05", count: 3 },
      { date: "2026-07-06", count: 0 },
    ]);
    expect(s.currentStreak).toBe(0);
  });

  it("splits into weeks of 7", () => {
    const days = withLevels(
      Array.from({ length: 14 }, (_, i) => ({ date: `d${i}`, count: i })),
    );
    const weeks = toWeeks(days);
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toHaveLength(7);
  });
});

describe("search grouping", () => {
  const r = (over: Partial<GhSearchResult>): GhSearchResult => ({
    id: Math.random().toString(),
    type: "repo",
    title: "t",
    origin: "live",
    score: 1,
    ...over,
  });

  it("groups by type in a stable order and de-dupes by id", () => {
    const groups = groupSearchResults([
      r({ id: "a", type: "user", score: 1 }),
      r({ id: "b", type: "repo", score: 1 }),
      r({ id: "b", type: "repo", score: 9 }), // dupe id ignored
      r({ id: "c", type: "contextos", score: 1 }),
    ]);
    expect(groups.map((g) => g.type)).toEqual(["contextos", "repo", "user"]);
  });

  it("ranks by score, then local before cached before live", () => {
    const groups = groupSearchResults([
      r({ id: "1", type: "repo", score: 5, origin: "live" }),
      r({ id: "2", type: "repo", score: 5, origin: "local" }),
      r({ id: "3", type: "repo", score: 8, origin: "live" }),
    ]);
    expect(groups[0].results.map((x) => x.id)).toEqual(["3", "2", "1"]);
  });

  it("only queries remotely for meaningful terms", () => {
    expect(shouldQueryRemote("re")).toBe(false);
    expect(shouldQueryRemote("  a ")).toBe(false);
    expect(shouldQueryRemote("react")).toBe(true);
  });
});
