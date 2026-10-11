/* GitHub integration domain layer.
   Pure types + normalization + contribution math. No network here — the
   provider/service layer performs I/O and hands raw API shapes to these
   functions. Everything in this file is unit-tested. */

/* ---------- Normalized records (link to Qutra Labs entities) ---------- */

export interface GhProfile {
  login: string;
  name: string | null;
  avatarUrl: string;
  bio: string | null;
  location: string | null;
  company: string | null;
  followers: number;
  following: number;
  htmlUrl: string;
  publicRepos: number;
}

export interface GhRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  private: boolean;
  archived: boolean;
  fork: boolean;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: number; // epoch ms
  htmlUrl: string;
  defaultBranch: string;
}

export interface GhContributionDay {
  date: string; // YYYY-MM-DD
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface GhContributionStats {
  total: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  maxInDay: number;
}

/* ---------- Normalization (raw GitHub API → normalized) ---------- */

export function normalizeProfile(api: Record<string, unknown>): GhProfile {
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const so = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    login: s(api.login),
    name: so(api.name),
    avatarUrl: s(api.avatar_url),
    bio: so(api.bio),
    location: so(api.location),
    company: so(api.company),
    followers: n(api.followers),
    following: n(api.following),
    htmlUrl: s(api.html_url),
    publicRepos: n(api.public_repos),
  };
}

export function normalizeRepo(api: Record<string, unknown>): GhRepo {
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const b = (v: unknown): boolean => v === true;
  const so = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const ownerObj = (api.owner ?? {}) as Record<string, unknown>;
  const pushed = typeof api.pushed_at === "string" ? Date.parse(api.pushed_at) : 0;
  return {
    id: n(api.id),
    owner: s(ownerObj.login),
    name: s(api.name),
    fullName: s(api.full_name),
    description: so(api.description),
    language: so(api.language),
    private: b(api.private),
    archived: b(api.archived),
    fork: b(api.fork),
    stars: n(api.stargazers_count),
    forks: n(api.forks_count),
    openIssues: n(api.open_issues_count),
    pushedAt: Number.isNaN(pushed) ? 0 : pushed,
    htmlUrl: s(api.html_url),
    defaultBranch: s(api.default_branch) || "main",
  };
}

/* ---------- Contribution calendar ---------- */

/** GitHub-style intensity bucket (0..4) for a day's count relative to the
 *  window's busiest day. Any non-zero count is at least level 1. */
export function contributionLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (max <= 0) return 1;
  const r = count / max;
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}

/** Assign levels to a list of {date, count} days. */
export function withLevels(
  days: { date: string; count: number }[],
): GhContributionDay[] {
  const max = days.reduce((m, d) => Math.max(m, d.count), 0);
  return days.map((d) => ({
    date: d.date,
    count: d.count,
    level: contributionLevel(d.count, max),
  }));
}

/**
 * Flatten GitHub GraphQL `contributionCalendar.weeks` into leveled days.
 * Tolerates partial/malformed payloads without throwing.
 */
export function normalizeContributionCalendar(raw: unknown): GhContributionDay[] {
  if (!raw || typeof raw !== "object") return [];
  const weeks = (raw as { weeks?: unknown }).weeks;
  if (!Array.isArray(weeks)) return [];
  const days: { date: string; count: number }[] = [];
  for (const week of weeks) {
    if (!week || typeof week !== "object") continue;
    const contributionDays = (week as { contributionDays?: unknown }).contributionDays;
    if (!Array.isArray(contributionDays)) continue;
    for (const day of contributionDays) {
      if (!day || typeof day !== "object") continue;
      const date = (day as { date?: unknown }).date;
      const count = (day as { contributionCount?: unknown }).contributionCount;
      if (typeof date !== "string" || !date) continue;
      days.push({
        date,
        count: typeof count === "number" && count >= 0 ? count : 0,
      });
    }
  }
  return withLevels(days);
}

/**
 * Compute honest contribution stats. Streaks are counted on consecutive
 * calendar days ending at the most recent day in the (date-sorted) input;
 * a trailing day with zero contributions does not break a streak that is
 * still "today or yesterday" ambiguous — callers pass days already trimmed
 * to the reporting window and a documented time zone.
 */
export function computeContributionStats(
  days: { date: string; count: number }[],
): GhContributionStats {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let total = 0;
  let activeDays = 0;
  let maxInDay = 0;
  let longest = 0;
  let run = 0;
  for (const d of sorted) {
    total += d.count;
    if (d.count > 0) {
      activeDays++;
      run++;
      longest = Math.max(longest, run);
      maxInDay = Math.max(maxInDay, d.count);
    } else {
      run = 0;
    }
  }
  // Current streak: consecutive active days at the end of the window.
  let current = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].count > 0) current++;
    else break;
  }
  return { total, activeDays, currentStreak: current, longestStreak: longest, maxInDay };
}

/** Split days into calendar weeks (columns of 7) for a heatmap grid. */
export function toWeeks(days: GhContributionDay[]): GhContributionDay[][] {
  const weeks: GhContributionDay[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }
  return weeks;
}

/* ---------- Unified search grouping ---------- */

export type GhResultOrigin = "local" | "cached" | "live";
export type GhResultType =
  | "user"
  | "repo"
  | "issue"
  | "pr"
  | "commit"
  | "release"
  | "contextos";

export interface GhSearchResult {
  id: string;
  type: GhResultType;
  title: string;
  subtitle?: string;
  url?: string;
  origin: GhResultOrigin;
  /** Higher = more relevant; used within a group. */
  score: number;
}

export interface GhResultGroup {
  type: GhResultType;
  results: GhSearchResult[];
}

const TYPE_ORDER: GhResultType[] = [
  "contextos",
  "repo",
  "user",
  "pr",
  "issue",
  "commit",
  "release",
];

/**
 * Group results by type (stable type order) and rank within each group by
 * score, then by origin (local first, then cached, then live) so already-known
 * local matches surface above remote ones. De-duplicates by id.
 */
export function groupSearchResults(results: GhSearchResult[]): GhResultGroup[] {
  const originRank: Record<GhResultOrigin, number> = { local: 0, cached: 1, live: 2 };
  const seen = new Set<string>();
  const byType = new Map<GhResultType, GhSearchResult[]>();
  for (const r of results) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }
  const groups: GhResultGroup[] = [];
  for (const type of TYPE_ORDER) {
    const list = byType.get(type);
    if (!list || list.length === 0) continue;
    list.sort(
      (a, b) => b.score - a.score || originRank[a.origin] - originRank[b.origin],
    );
    groups.push({ type, results: list });
  }
  return groups;
}

/** A remote query should only fire for a meaningful term. */
export function shouldQueryRemote(term: string): boolean {
  return term.trim().length >= 3;
}
