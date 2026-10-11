import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ASSISTANT_BASE_URL,
  ASSISTANT_CONTEXT_CHOICES,
  ASSISTANT_FIRST_TOKEN_TIMEOUT_MS,
  ASSISTANT_HEALTH_TIMEOUT_MS,
  ASSISTANT_TOTAL_TIMEOUT_MS,
  DEFAULT_ASSISTANT_BASE_URL,
  DEFAULT_ASSISTANT_MODEL,
  isOllamaModelName,
  ALLOWED_OLLAMA_PORTS,
  ASSISTANT_ALLOWED_ENDPOINTS,
  assistantEndpoint,
  assistantRequestGate,
  checkAssistantBaseUrl,
  chunkText,
  parseChatStreamBuffer,
  resolveAssistantBaseUrl,
} from "./localAssistant";

describe("local assistant defaults", () => {
  it("targets the closed set, preferring ordinary Ollama on 11434", () => {
    expect(ASSISTANT_ALLOWED_ENDPOINTS).toEqual([
      "http://127.0.0.1:11434",
      "http://127.0.0.1:11435",
    ]);
    expect(DEFAULT_ASSISTANT_BASE_URL).toBe("http://127.0.0.1:11434");
    expect(ALLOWED_OLLAMA_PORTS).toEqual([11434, 11435]);
    expect(DEFAULT_ASSISTANT_MODEL).toBe("qwen2.5:14b");
  });

  it("offers only small context sizes (262k is out of scope)", () => {
    expect(ASSISTANT_CONTEXT_CHOICES).toEqual([4096, 8192]);
  });
});

describe("loopback-only URL rule", () => {
  it("accepts both closed-set members and normalizes to an origin", () => {
    expect(checkAssistantBaseUrl("http://127.0.0.1:11434")).toEqual({
      ok: true,
      url: "http://127.0.0.1:11434",
    });
    expect(checkAssistantBaseUrl("http://127.0.0.1:11435")).toEqual({
      ok: true,
      url: "http://127.0.0.1:11435",
    });
    expect(checkAssistantBaseUrl("http://localhost:11434")).toEqual({
      ok: true,
      url: "http://localhost:11434",
    });
    expect(checkAssistantBaseUrl("http://localhost:11435")).toEqual({
      ok: true,
      url: "http://localhost:11435",
    });
    // A stray path would otherwise be concatenated into every endpoint.
    expect(checkAssistantBaseUrl("http://127.0.0.1:11435/v1/")).toEqual({
      ok: true,
      url: "http://127.0.0.1:11435",
    });
  });

  it("rejects any non-loopback host", () => {
    for (const url of [
      "http://8.8.8.8:11435",
      "http://example.com",
      "https://api.openai.com",
      "http://192.168.1.10:11435",
      "http://10.0.0.5:11435",
      // Looks loopback-ish but is not: a remote host whose name embeds it.
      "http://127.0.0.1.evil.com:11435",
    ]) {
      expect(checkAssistantBaseUrl(url), url).toEqual({
        ok: false,
        reason: "not_loopback",
      });
    }
  });

  it("accepts the user's own default Ollama on 11434 and rejects any other loopback port", () => {
    // 11434 is a closed-set member. A host-only rule would also let
    // 11436 through; the port check is what keeps the set closed.
    expect(checkAssistantBaseUrl("http://127.0.0.1:11434")).toEqual({
      ok: true,
      url: "http://127.0.0.1:11434",
    });
    expect(checkAssistantBaseUrl("http://localhost:11434")).toEqual({
      ok: true,
      url: "http://localhost:11434",
    });
    expect(checkAssistantBaseUrl("http://127.0.0.1:11436")).toEqual({
      ok: false,
      reason: "default_ollama_port",
    });
    expect(checkAssistantBaseUrl("http://localhost:9999")).toEqual({
      ok: false,
      reason: "default_ollama_port",
    });
  });

  it("rejects non-http schemes and unparseable input", () => {
    expect(checkAssistantBaseUrl("file:///etc/passwd").ok).toBe(false);
    expect(checkAssistantBaseUrl("ws://127.0.0.1:11435")).toEqual({
      ok: false,
      reason: "non_http_scheme",
    });
    expect(checkAssistantBaseUrl("not a url")).toEqual({
      ok: false,
      reason: "invalid_url",
    });
    expect(checkAssistantBaseUrl("")).toEqual({ ok: false, reason: "invalid_url" });
  });
});

describe("request gate", () => {
  it("refuses while the lab is disabled", () => {
    expect(assistantRequestGate({ localAssistantEnabled: false })).toEqual({
      allowed: false,
      reason: "disabled",
    });
  });

  it("resolves to the pinned endpoint when enabled", () => {
    expect(assistantRequestGate({ localAssistantEnabled: true })).toEqual({
      allowed: true,
      baseUrl: ASSISTANT_BASE_URL,
    });
  });
});

/* The runtime endpoint is pinned to a constant. The URL policy above is
   still the rule, but it no longer takes user input: a stored preference is
   compared against the constant and otherwise ignored. This closes the gap
   where the validator accepted loopback ports the CSP would then block, which
   surfaced to the user as an unexplainable failure. */
describe("endpoint is pinned, not configured", () => {
  it("ignores a stored endpoint that is not the pinned one", () => {
    for (const stored of [
      "http://127.0.0.1:9999", // some other loopback service
      "http://example.com", // off-loopback
      "",
      undefined,
    ]) {
      const resolved = resolveAssistantBaseUrl(stored);
      expect(resolved.url, String(stored)).toBe(ASSISTANT_BASE_URL);
      expect(resolved.stale, String(stored)).toBe(true);
    }
  });

  it("reports a stored closed-set member as current", () => {
    expect(resolveAssistantBaseUrl(ASSISTANT_BASE_URL)).toEqual({
      url: ASSISTANT_BASE_URL,
      stale: false,
    });
    expect(resolveAssistantBaseUrl("http://127.0.0.1:11435")).toEqual({
      url: ASSISTANT_BASE_URL,
      stale: false,
    });
  });

  it("pins the fallback display to the IPv4 loopback literal, not localhost", () => {
    expect(ASSISTANT_BASE_URL).toBe("http://127.0.0.1:11434");
    expect(ASSISTANT_BASE_URL).not.toContain("localhost");
  });
});

describe("timeouts are bounded", () => {
  it("fails closed rather than hanging forever", () => {
    // Without a timeout the only way out of a wedged request is the user pressing
    // Stop, so a dropped (not refused) connection hung the surface indefinitely.
    expect(ASSISTANT_HEALTH_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000);
    expect(ASSISTANT_HEALTH_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    // Measured: a 27B model needs ~29s cold, so the budget must clear that by
    // a real margin rather than sitting on top of it.
    expect(ASSISTANT_FIRST_TOKEN_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(ASSISTANT_TOTAL_TIMEOUT_MS).toBeGreaterThan(
      ASSISTANT_FIRST_TOKEN_TIMEOUT_MS,
    );
  });
});

describe("endpoints", () => {
  it("joins without doubling slashes", () => {
    expect(assistantEndpoint("http://127.0.0.1:11435", "/api/tags")).toBe(
      "http://127.0.0.1:11435/api/tags",
    );
    expect(assistantEndpoint("http://127.0.0.1:11435/", "/api/chat")).toBe(
      "http://127.0.0.1:11435/api/chat",
    );
  });
});

describe("NDJSON stream parsing", () => {
  it("returns complete lines and carries the partial remainder", () => {
    const { chunks, rest } = parseChatStreamBuffer(
      '{"message":{"content":"Hel"}}\n{"message":{"content":"lo"}}\n{"messa',
    );
    expect(chunks.map(chunkText)).toEqual(["Hel", "lo"]);
    // Dropping this remainder is how the last token goes missing.
    expect(rest).toBe('{"messa');
  });

  it("skips malformed lines instead of killing the stream", () => {
    const { chunks } = parseChatStreamBuffer(
      '{"message":{"content":"a"}}\nnot json\n{"message":{"content":"b"}}\n',
    );
    expect(chunks.map(chunkText)).toEqual(["a", "b"]);
  });

  it("reports completion and tolerates empty lines", () => {
    const { chunks, rest } = parseChatStreamBuffer(
      '\n{"done":true}\n',
    );
    expect(chunks).toEqual([{ done: true }]);
    expect(rest).toBe("");
  });
});

/* The webview cannot reach the lab unless CSP allows the loopback origin, so
   that grant is part of this feature's surface. It is asserted here to keep the
   widening minimal and intentional: a future "just add a wildcard to make it
   work" edit should fail a test rather than quietly enlarge the boundary. */
describe("CSP grants loopback only", () => {
  const csp: string = JSON.parse(
    fs.readFileSync(
      path.resolve(process.cwd(), "src-tauri/tauri.conf.json"),
      "utf8",
    ),
  ).app.security.csp;

  /* There are two policies, and both are enforced: `tauri.conf.json` governs
     the packaged window, while the `<meta>` tag in index.html governs the
     document in every build including dev. Updating only one leaves the
     assistant blocked in the other — which is exactly what happened, and was
     only caught by a test that made a real request. They must stay identical. */
  const htmlCsp =
    /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/.exec(
      fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8"),
    )?.[1] ?? "";

  it("is identical in tauri.conf.json and index.html", () => {
    expect(htmlCsp, "index.html must carry a CSP meta tag").not.toBe("");
    expect(htmlCsp).toBe(csp);
  });

  const connectSrc =
    csp
      .split(";")
      .map((d: string) => d.trim())
      .find((d: string) => d.startsWith("connect-src")) ?? "";

  /* Every Ollama request goes through the Rust broker, so the webview does not
     need — and does not have — permission to reach the lab at all.
     Keeping this narrow is the point: the renderer being
     unable to make the request is a stronger guarantee than it being trusted
     not to. */
  it("no longer grants the renderer any Ollama origin", () => {
    expect(connectSrc).not.toContain("11435");
    expect(connectSrc).not.toContain("127.0.0.1");
  });

  it("never allows the default Ollama port", () => {
    expect(csp).not.toContain("11434");
  });

  it("has no wildcard or external origin in connect-src", () => {
    expect(connectSrc).not.toContain("*");
    expect(connectSrc).not.toContain("https://");
    // Only 'self' and the Tauri IPC origins remain.
    const tokens = connectSrc.replace("connect-src", "").trim().split(/\s+/);
    expect(tokens.sort()).toEqual(
      ["'self'", "http://ipc.localhost", "ipc:"].sort(),
    );
  });

  it("keeps the rest of the policy locked down", () => {
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
  });
});

/* Model policy. The endpoint is a security boundary and is pinned;
   the model is a user preference and is not. Conflating the two is how a
   "safe default" turns into a hard-coded model nobody can change. */
describe("model is a preference, not a pin", () => {
  it("defaults to the user's chosen model", () => {
    expect(DEFAULT_ASSISTANT_MODEL).toBe("qwen2.5:14b");
  });

  it("names no model in the endpoint policy", () => {
    // The endpoint constant must not encode a model, or swapping models would
    // become an endpoint change.
    expect(ASSISTANT_BASE_URL).not.toContain("gemma");
    expect(ASSISTANT_BASE_URL).not.toContain("qwen");
  });
});

describe("isOllamaModelName — the only names Qutra turns into a shell command", () => {
  // The readiness panel offers `ollama pull <name>` for the user to paste
  // into a shell, and the name can come from any listener's model list.
  it.each([
    "qwen2.5:14b",
    "llama3",
    "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M",
    "my_model-v2:latest",
  ])("accepts %s", (name) => {
    expect(isOllamaModelName(name)).toBe(true);
  });

  it.each([
    "evil & calc.exe",
    "qwen2.5:14b calc",
    "a;del *",
    "$(whoami)",
    "`whoami`",
    "a|b",
    "",
    // a leading dash would be read by `ollama pull` as an option
    "-rf",
  ])("refuses %j", (name) => {
    expect(isOllamaModelName(name)).toBe(false);
  });
});
