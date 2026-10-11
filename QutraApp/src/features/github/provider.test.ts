import { describe, expect, it, vi } from "vitest";
import { GitHubProvider, GitHubApiError } from "./provider";

function res(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as Response;
}

const token = () => Promise.resolve("ghp_testtoken0000000000000000");

describe("GitHubProvider requests", () => {
  it("sends a bearer token and normalizes the profile", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      res(200, { login: "mert", avatar_url: "a", followers: 3 }, { etag: "W/1" }),
    );
    const p = new GitHubProvider({ fetchImpl: fetchImpl as unknown as typeof fetch, getToken: token });
    const profile = await p.getProfile();
    expect(profile.login).toBe("mert");
    const [, init] = fetchImpl.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer ghp_testtoken0000000000000000",
    });
  });

  it("serves cached data on a 304 conditional response", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      call++;
      return call === 1
        ? res(200, [{ id: 1, name: "r", owner: { login: "m" } }], { etag: 'W/"abc"' })
        : res(304, null, {});
    });
    const p = new GitHubProvider({ fetchImpl: fetchImpl as unknown as typeof fetch, getToken: token });
    const first = await p.getRepos();
    const second = await p.getRepos();
    expect(second).toEqual(first);
    // Second call must have sent If-None-Match.
    const secondInit = fetchImpl.mock.calls[1][1] as RequestInit;
    expect((secondInit.headers as Record<string, string>)["If-None-Match"]).toBe('W/"abc"');
  });

  it("maps 403 with zero remaining to rate_limited and records the reset", async () => {
    const fetchImpl = vi.fn(async () =>
      res(403, {}, { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000" }),
    );
    const p = new GitHubProvider({ fetchImpl: fetchImpl as unknown as typeof fetch, getToken: token });
    await expect(p.getProfile()).rejects.toMatchObject({ code: "rate_limited" });
    expect(p.lastRate).toMatchObject({ remaining: 0, resetAt: 1000_000 });
  });

  it("errors offline and never leaks the token in the error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ghp_testtoken0000000000000000 network down");
    });
    const p = new GitHubProvider({ fetchImpl: fetchImpl as unknown as typeof fetch, getToken: token });
    const err = await p.getProfile().catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.code).toBe("offline");
    expect(err.message).not.toContain("ghp_");
  });

  it("throws not_connected when there is no token", async () => {
    const p = new GitHubProvider({
      fetchImpl: (async () => res(200, {})) as unknown as typeof fetch,
      getToken: () => Promise.resolve(null),
    });
    await expect(p.getProfile()).rejects.toMatchObject({ code: "not_connected" });
  });

  it("validates PAT shape before storing", async () => {
    const p = new GitHubProvider({ getToken: token });
    const bad = await p.connectWithToken("nope");
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("invalid_token_format");
  });

  it("loads contribution days from GraphQL", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.github.com/graphql");
      return res(200, {
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: {
                weeks: [
                  {
                    contributionDays: [
                      { date: "2026-07-01", contributionCount: 2 },
                      { date: "2026-07-02", contributionCount: 0 },
                    ],
                  },
                ],
              },
            },
          },
        },
      });
    });
    const p = new GitHubProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: token,
    });
    const days = await p.getContributions("mert");
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ date: "2026-07-01", count: 2, level: 4 });
  });
});
