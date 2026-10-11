/* Tauri → Rust GitHub broker transport. No renderer fetch to github hosts. */

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/runtime";

export interface BrokerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function headerMap(headers: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    h.set(k, v);
  }
  return h;
}

/** Build a Response-like object from the broker DTO. */
export function brokerToResponse(dto: BrokerResponse): Response {
  return {
    status: dto.status,
    ok: dto.status >= 200 && dto.status < 300,
    headers: headerMap(dto.headers),
    json: async () => (dto.body ? JSON.parse(dto.body) : null),
    text: async () => dto.body,
  } as unknown as Response;
}

/**
 * Fetch-compatible wrapper that routes api.github.com traffic through Rust.
 * Used only when running under Tauri; unit tests inject their own fetchImpl.
 */
export function createBrokerFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/graphql") && method === "POST") {
      let login = "";
      try {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as {
          variables?: { login?: string };
        };
        login = parsed.variables?.login ?? "";
      } catch {
        throw new TypeError("offline");
      }
      const dto = await invoke<BrokerResponse>("github_graphql", { login });
      return brokerToResponse(dto);
    }

    if (!url.startsWith("https://api.github.com/")) {
      throw new TypeError("offline");
    }
    const path = url.slice("https://api.github.com".length);
    const headers = init?.headers as Record<string, string> | undefined;
    const ifNoneMatch = headers?.["If-None-Match"] ?? headers?.["if-none-match"];
    try {
      const dto = await invoke<BrokerResponse>("github_api_get", {
        path,
        ifNoneMatch: ifNoneMatch ?? null,
      });
      return brokerToResponse(dto);
    } catch (err) {
      const code = String(err);
      if (code === "not_connected" || code.includes("not_connected")) {
        // Surface as a synthetic 401-less offline/unauthorized path to provider.
        throw new TypeError("offline");
      }
      if (code === "offline" || code.includes("offline")) {
        throw new TypeError("offline");
      }
      throw new TypeError("offline");
    }
  }) as unknown as typeof fetch;
}

export function defaultGithubFetch(): typeof fetch {
  if (isTauriRuntime()) return createBrokerFetch();
  // Browser demo: CSP blocks github hosts; callers must inject fetch or use demo.
  return fetch.bind(globalThis);
}
