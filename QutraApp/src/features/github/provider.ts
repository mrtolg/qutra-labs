/* GitHubProvider — the only place that talks to the GitHub REST API.
   React components call this, never fetch() directly (ADR 0006). Tokens live
   in the OS secure store; nothing here logs or returns the token. The fetch
   implementation is injectable so ETag/rate-limit/redaction are unit-tested. */

import { getBridge } from "@/lib/bridge";
import {
  normalizeProfile,
  normalizeRepo,
  normalizeContributionCalendar,
  type GhProfile,
  type GhRepo,
  type GhContributionDay,
} from "@/domain/github";
import { defaultGithubFetch } from "./brokerTransport";
import { isTauriRuntime } from "@/lib/runtime";

export const GITHUB_TOKEN_KEY = "github.token";
const API = "https://api.github.com";

/** Client id for Device Flow. Configured at build/runtime, never a secret. */
export function githubClientId(): string | null {
  const id = (import.meta.env?.VITE_GITHUB_CLIENT_ID as string | undefined) ?? "";
  return id.trim() ? id.trim() : null;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: number; // epoch ms
}

export type GhError =
  | "not_connected"
  | "unauthorized"
  | "rate_limited"
  | "not_found"
  | "offline"
  | "forbidden"
  | "github_error";

export class GitHubApiError extends Error {
  constructor(
    readonly code: GhError,
    readonly rate?: RateLimit,
  ) {
    super(code); // message is a stable code — never contains a token
    this.name = "GitHubApiError";
  }
}

interface CacheEntry {
  etag: string;
  data: unknown;
}

export interface ProviderDeps {
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string | null>;
}

export class GitHubProvider {
  private fetchImpl: typeof fetch;
  private getTokenFn: () => Promise<string | null>;
  private tokenOwnedByNativeBroker: boolean;
  private etagCache = new Map<string, CacheEntry>();
  lastRate: RateLimit | null = null;

  constructor(deps: ProviderDeps = {}) {
    // Desktop: Rust broker owns HTTPS to api.github.com (CSP stays closed).
    // Tests / browser inject fetchImpl explicitly.
    this.fetchImpl = deps.fetchImpl ?? defaultGithubFetch();
    this.tokenOwnedByNativeBroker = !deps.fetchImpl && isTauriRuntime();
    // The page never reads the token: on desktop the Rust broker adds it
    // to each request itself, and the browser build has none to read.
    this.getTokenFn = deps.getToken ?? (async () => null);
  }

  /* ---- Connection lifecycle ---- */

  async isConnected(): Promise<boolean> {
    return getBridge().secureStore.has(GITHUB_TOKEN_KEY);
  }

  /** Store a fine-grained PAT (dev fallback). Validates shape only. */
  async connectWithToken(token: string): Promise<{ ok: boolean; reason?: string }> {
    const t = token.trim();
    if (!/^gh[pousr]_[A-Za-z0-9_]{20,}$/.test(t) && !/^github_pat_[A-Za-z0-9_]{20,}$/.test(t)) {
      return { ok: false, reason: "invalid_token_format" };
    }
    return getBridge().secureStore.set(GITHUB_TOKEN_KEY, t);
  }

  /** Revoke locally: delete the token and any cached responses. */
  async disconnect(): Promise<void> {
    this.etagCache.clear();
    this.lastRate = null;
    await getBridge().secureStore.delete(GITHUB_TOKEN_KEY);
  }

  /* ---- Requests ---- */

  private parseRate(res: Response): RateLimit | undefined {
    const limit = Number(res.headers.get("x-ratelimit-limit"));
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isNaN(limit) || Number.isNaN(remaining)) return undefined;
    return { limit, remaining, resetAt: (reset || 0) * 1000 };
  }

  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    const token = this.tokenOwnedByNativeBroker
      ? null
      : await this.getTokenFn();
    if (!this.tokenOwnedByNativeBroker && !token) {
      throw new GitHubApiError("not_connected");
    }
    const url = `${API}${path}`;
    const cached = this.etagCache.get(url);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cached) headers["If-None-Match"] = cached.etag;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal });
    } catch {
      throw new GitHubApiError("offline");
    }
    const rate = this.parseRate(res);
    if (rate) this.lastRate = rate;

    // Conditional request hit — serve the cached body.
    if (res.status === 304 && cached) return cached.data as T;

    if (res.status === 401) throw new GitHubApiError("unauthorized", rate);
    if (res.status === 404) throw new GitHubApiError("not_found", rate);
    if (res.status === 403) {
      // Distinguish rate-limit from other forbidden.
      if (rate && rate.remaining === 0) throw new GitHubApiError("rate_limited", rate);
      throw new GitHubApiError("forbidden", rate);
    }
    if (!res.ok) throw new GitHubApiError("github_error", rate);

    const etag = res.headers.get("etag");
    const data = (await res.json()) as T;
    if (etag) this.etagCache.set(url, { etag, data });
    return data;
  }

  async getProfile(signal?: AbortSignal): Promise<GhProfile> {
    return normalizeProfile(await this.request<Record<string, unknown>>("/user", signal));
  }

  async getRepos(signal?: AbortSignal): Promise<GhRepo[]> {
    const raw = await this.request<Record<string, unknown>[]>(
      "/user/repos?per_page=100&sort=pushed",
      signal,
    );
    return raw.map(normalizeRepo);
  }

  /**
   * Contribution calendar via GraphQL. Returns an empty array when the
   * query is rejected or the payload is incomplete — callers must not invent days.
   */
  async getContributions(
    login: string,
    signal?: AbortSignal,
  ): Promise<GhContributionDay[]> {
    const token = this.tokenOwnedByNativeBroker
      ? null
      : await this.getTokenFn();
    if (!this.tokenOwnedByNativeBroker && !token) {
      throw new GitHubApiError("not_connected");
    }
    const query = `query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            weeks {
              contributionDays { date contributionCount }
            }
          }
        }
      }
    }`;
    let res: Response;
    try {
      res = await this.fetchImpl("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables: { login } }),
        signal,
      });
    } catch {
      throw new GitHubApiError("offline");
    }
    const rate = this.parseRate(res);
    if (rate) this.lastRate = rate;
    if (res.status === 401) throw new GitHubApiError("unauthorized", rate);
    if (res.status === 403) {
      if (rate && rate.remaining === 0) throw new GitHubApiError("rate_limited", rate);
      throw new GitHubApiError("forbidden", rate);
    }
    if (!res.ok) throw new GitHubApiError("github_error", rate);

    const body = (await res.json()) as {
      data?: {
        user?: {
          contributionsCollection?: {
            contributionCalendar?: unknown;
          };
        };
      };
      errors?: unknown;
    };
    if (body.errors) return [];
    return normalizeContributionCalendar(
      body.data?.user?.contributionsCollection?.contributionCalendar,
    );
  }
}
