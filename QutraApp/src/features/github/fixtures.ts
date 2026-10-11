/* Deterministic GitHub demo fixtures. Used for the "preview with demo data"
   mode and E2E/visual tests so the connected UI is reproducible without a real
   token. Clearly labeled as demo in the UI — never presented as live data. */

import {
  withLevels,
  type GhProfile,
  type GhRepo,
  type GhContributionDay,
} from "@/domain/github";

export const demoProfile: GhProfile = {
  login: "mert-demo",
  name: "Mert (demo)",
  avatarUrl: "",
  bio: "Local-first tooling. This is deterministic demo data.",
  location: "Istanbul",
  company: "Qutra Labs",
  followers: 128,
  following: 64,
  htmlUrl: "https://github.com/mert-demo",
  publicRepos: 24,
};

export const demoRepos: GhRepo[] = [
  { id: 1, owner: "mert-demo", name: "contextos", fullName: "mert-demo/contextos", description: "Local-first desktop command center.", language: "TypeScript", private: false, archived: false, fork: false, stars: 342, forks: 21, openIssues: 7, pushedAt: Date.parse("2026-07-20T09:00:00Z"), htmlUrl: "https://github.com/mert-demo/contextos", defaultBranch: "main" },
  { id: 2, owner: "mert-demo", name: "native-bridge", fullName: "mert-demo/native-bridge", description: "Windows window enumeration in Rust.", language: "Rust", private: false, archived: false, fork: false, stars: 88, forks: 4, openIssues: 2, pushedAt: Date.parse("2026-07-12T14:00:00Z"), htmlUrl: "https://github.com/mert-demo/native-bridge", defaultBranch: "main" },
  { id: 3, owner: "mert-demo", name: "sigma-lab", fullName: "mert-demo/sigma-lab", description: "Offline Sigma rule explorer.", language: "Python", private: true, archived: false, fork: false, stars: 0, forks: 0, openIssues: 1, pushedAt: Date.parse("2026-06-30T08:00:00Z"), htmlUrl: "https://github.com/mert-demo/sigma-lab", defaultBranch: "main" },
  { id: 4, owner: "mert-demo", name: "dotfiles", fullName: "mert-demo/dotfiles", description: null, language: "Shell", private: false, archived: true, fork: false, stars: 12, forks: 1, openIssues: 0, pushedAt: Date.parse("2025-11-02T08:00:00Z"), htmlUrl: "https://github.com/mert-demo/dotfiles", defaultBranch: "main" },
  { id: 5, owner: "mert-demo", name: "tauri-notes", fullName: "mert-demo/tauri-notes", description: "Fork with experiments.", language: "TypeScript", private: false, archived: false, fork: true, stars: 3, forks: 0, openIssues: 0, pushedAt: Date.parse("2026-05-18T08:00:00Z"), htmlUrl: "https://github.com/mert-demo/tauri-notes", defaultBranch: "main" },
];

/** A deterministic year of contribution days ending today. */
export function demoContributions(endMs = Date.parse("2026-07-23T00:00:00Z")): GhContributionDay[] {
  const days: { date: string; count: number }[] = [];
  const DAY = 86_400_000;
  for (let i = 363; i >= 0; i--) {
    const d = new Date(endMs - i * DAY);
    const iso = d.toISOString().slice(0, 10);
    // Deterministic pseudo-random: weekdays busier than weekends.
    const seed = (d.getUTCFullYear() * 372 + (d.getUTCMonth() + 1) * 31 + d.getUTCDate()) % 97;
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    let count = seed % (weekend ? 3 : 8);
    if (seed % 11 === 0) count = 0;
    days.push({ date: iso, count });
  }
  return withLevels(days);
}
