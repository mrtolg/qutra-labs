/* ============================================================
   Global search: tokenized matching + composite ranking.
   Rank by: exact match > prefix > substring, then recency,
   frequency, current-workspace affinity and favorites.
   ============================================================ */

export interface SearchDoc {
  id: string;
  type:
    | "command"
    | "workspace"
    | "task"
    | "resource"
    | "setting"
    | "session";
  title: string;
  subtitle?: string;
  keywords?: string;
  workspaceId?: string;
  updatedAt?: number;
  useCount?: number;
  favorite?: boolean;
}

export interface RankedResult extends SearchDoc {
  score: number;
}

function fold(s: string): string {
  return s
    .replaceAll("ı", "i")
    .replaceAll("ß", "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

export function rankSearch(
  docs: SearchDoc[],
  query: string,
  opts: { currentWorkspaceId?: string; now?: number; limit?: number } = {},
): RankedResult[] {
  const q = fold(query.trim());
  const now = opts.now ?? Date.now();
  if (!q) return [];
  const terms = q.split(/\s+/);

  const results: RankedResult[] = [];
  for (const doc of docs) {
    const title = fold(doc.title);
    const haystack = `${title} ${fold(doc.subtitle ?? "")} ${fold(doc.keywords ?? "")}`;

    let matchScore = 0;
    let allMatch = true;
    for (const term of terms) {
      if (title === term) matchScore += 100;
      else if (title.startsWith(term)) matchScore += 60;
      else if (title.includes(term)) matchScore += 35;
      else if (haystack.includes(term)) matchScore += 18;
      else {
        allMatch = false;
        break;
      }
    }
    if (!allMatch || matchScore === 0) continue;

    // Recency: up to 20 points, decaying over 30 days.
    let recency = 0;
    if (doc.updatedAt) {
      const ageDays = (now - doc.updatedAt) / 86_400_000;
      recency = Math.max(0, 20 - ageDays * (20 / 30));
    }
    const frequency = Math.min(15, (doc.useCount ?? 0) * 3);
    const wsBoost =
      opts.currentWorkspaceId && doc.workspaceId === opts.currentWorkspaceId
        ? 12
        : 0;
    const favBoost = doc.favorite ? 10 : 0;

    results.push({
      ...doc,
      score: matchScore + recency + frequency + wsBoost + favBoost,
    });
  }

  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return results.slice(0, opts.limit ?? 40);
}
