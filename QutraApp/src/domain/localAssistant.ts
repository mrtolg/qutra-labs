/* ============================================================
   Local Assistant Lab — pure authorization + endpoint rules (ADR 0010, §3.14).

   Everything that decides *whether a request may happen at all* lives here, as
   pure functions with no network and no I/O. The HTTP client is a thin caller
   that must ask this module first.

   That split is deliberate: the guarantees this feature makes —    never call out
   while disabled, never leave loopback, never leave the closed set
   {11434, 11435} — are then testable without mocking a network, and they hold
   regardless of which transport ends up performing the request (today `fetch`,
   possibly Rust later).
   ============================================================ */

/**
 * The closed set of origins Rust will ever send assistant traffic to.
 * Preference, IPC and model output cannot add a third.
 *
 * `127.0.0.1` rather than `localhost` on purpose: `localhost` can resolve to
 * `::1` first, and both listeners are IPv4.
 */
export const ASSISTANT_ALLOWED_ENDPOINTS = [
  "http://127.0.0.1:11434",
  "http://127.0.0.1:11435",
] as const;

/** Preferred member — probed first. Ordinary user Ollama. */
export const ASSISTANT_BASE_URL = ASSISTANT_ALLOWED_ENDPOINTS[0];

/** Kept as the preference default so stored values match a set member. */
export const DEFAULT_ASSISTANT_BASE_URL = ASSISTANT_BASE_URL;
/** Official Qwen 2.5 14B (`qwen2.5:14b` on Ollama). Apache 2.0, tool-capable,
    same size class as the previous default. Not a third-party reupload with
    safety training removed. */
export const DEFAULT_ASSISTANT_MODEL = "qwen2.5:14b";

/** Characters Ollama uses in model names (`namespace/name:tag`). A name that
    comes from a listener's model list is untrusted, and the readiness panel
    offers it inside a command meant to be pasted into a shell — so only names
    made of these characters, not starting with a dash (an option to
    `ollama pull`), are ever put in one. */
const OLLAMA_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export function isOllamaModelName(name: string): boolean {
  return OLLAMA_MODEL_NAME.test(name);
}

/* Timeouts. Every one of these existed only as "the user eventually presses
   Stop" before, so a wedged endpoint hung the surface indefinitely. */

/** Health probe: the lab is either listening on loopback or it is not. */
export const ASSISTANT_HEALTH_TIMEOUT_MS = 5_000;
/**
 * First-token budget.
 *
 * 30s was a guess and it was wrong. Measured cold-start on this machine's lab:
 * 7B → 7.8s, 14B → 15.0s, 27B → 29.3s. The largest working model cleared the
 * old ceiling by 0.7 seconds, so any slower disk or busier GPU would have
 * failed a healthy request.
 *
 * This deadline exists to catch a *wedged* endpoint, not to race a model load,
 * so it is set well clear of the slowest legitimate case rather than trimmed to
 * it. The total ceiling still bounds the whole turn.
 */
export const ASSISTANT_FIRST_TOKEN_TIMEOUT_MS = 120_000;
/** Absolute ceiling for one answer, so a stuck stream cannot run forever. */
export const ASSISTANT_TOTAL_TIMEOUT_MS = 5 * 60_000;

/** Ports in the closed set. Anything else is refused by name, even on
    loopback — that is how the set stays closed. */
export const ALLOWED_OLLAMA_PORTS = [11434, 11435] as const;

/** First release stays small on purpose; 262k is explicitly out of scope. */
export const ASSISTANT_CONTEXT_CHOICES = [4096, 8192] as const;
export type AssistantContextTokens = (typeof ASSISTANT_CONTEXT_CHOICES)[number];

/** Hosts that count as loopback. Anything else is rejected. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export type AssistantUrlRejection =
  | "invalid_url"
  | "non_http_scheme"
  | "not_loopback"
  | "default_ollama_port";

export type AssistantUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: AssistantUrlRejection };

/**
 * Validate a user-supplied base URL for the local assistant.
 *
 * Returns the normalized origin on success. Rejections are typed so the UI can
 * explain precisely which rule was hit instead of showing a generic failure.
 */
export function checkAssistantBaseUrl(raw: string): AssistantUrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  // A non-HTTP scheme could otherwise smuggle in file:, data: or a custom
  // handler that never goes through the loopback check meaningfully.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "non_http_scheme" };
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { ok: false, reason: "not_loopback" };
  }

  // Checked separately from loopback: a host-only rule would accept any
  // loopback port. Only the two closed-set members are allowed.
  const port = Number(parsed.port);
  if (!(ALLOWED_OLLAMA_PORTS as readonly number[]).includes(port)) {
    return { ok: false, reason: "default_ollama_port" };
  }

  // Normalize to an origin — a stray path would otherwise be concatenated into
  // every endpoint below and silently produce /foo/api/tags.
  return { ok: true, url: parsed.origin };
}

/** Convenience predicate for call sites that only need a yes/no. */
export function isAllowedAssistantBaseUrl(raw: string): boolean {
  return checkAssistantBaseUrl(raw).ok;
}

/**
 * Resolve the endpoint actually used at runtime.
 *
 * A stored preference is **not** trusted as an endpoint. It is compared against
 * the pinned constant and otherwise ignored, so a hand-edited or migrated
 * profile can never redirect traffic — not to 11434, not off-loopback, not
 * through a proxy host. The caller can show `stale: true` to explain why the
 * displayed endpoint differs from what is stored.
 */
export function resolveAssistantBaseUrl(stored: string | undefined): {
  url: string;
  stale: boolean;
} {
  const normalized = checkAssistantBaseUrl(stored ?? "");
  const inSet =
    normalized.ok &&
    (ASSISTANT_ALLOWED_ENDPOINTS as readonly string[]).includes(normalized.url);
  // The renderer never chooses the live origin. Health reports what Rust
  // selected; this fallback is the preferred member of the closed set.
  return { url: ASSISTANT_BASE_URL, stale: !inSet };
}

/** The subset of Preferences this module needs, so tests need not build a
    whole Preferences object. */
export interface AssistantGateInput {
  localAssistantEnabled: boolean;
}

export type AssistantGateResult =
  | { allowed: true; baseUrl: string }
  | { allowed: false; reason: "disabled" | AssistantUrlRejection };

/**
 * The single gate every request passes through.
 *
 * The opt-in is the only input: the endpoint is the pinned constant, which is
 * still run through the policy check as defence in depth so that a future edit
 * to the constant cannot quietly introduce 11434 or a non-loopback host.
 */
export function assistantRequestGate(
  input: AssistantGateInput,
): AssistantGateResult {
  if (!input.localAssistantEnabled) {
    return { allowed: false, reason: "disabled" };
  }
  const check = checkAssistantBaseUrl(ASSISTANT_BASE_URL);
  if (!check.ok) return { allowed: false, reason: check.reason };
  return { allowed: true, baseUrl: check.url };
}

/** Build an endpoint from an already-validated base URL. */
export function assistantEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/* ---------------- Ollama wire shapes ---------------- */

export interface AssistantMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** On a stored answer: the origin and model its turn was sent to. Shown to
      the user; stripped before anything goes back to the model. */
  answeredBy?: { endpoint: string; model: string };
  /** On a Claude answer: its content blocks, echoed unchanged next turn. */
  blocks?: unknown[];
  /** On a cloud answer: where it went, who answered, what it cost. */
  cloud?: import("./conversations").SavedMessage["cloud"];
  /** On a question that went to the cloud: it is sent again as it went,
      masked (`cloudContent` when masking changed it). */
  cloudSent?: boolean;
  cloudContent?: string;
  /** On a question about an investigation: the summary that went with it. */
  context?: string;
  /** On a web-enabled answer: the pages it drew on, cited ones first. */
  sources?: import("./conversations").WebSource[];
  /** On the first cloud question: Jarvis's memory and instructions. */
  personal?: string;
}

/** One NDJSON line from `/api/chat`. */
export interface OllamaChatChunk {
  message?: { role?: string; content?: string };
  done?: boolean;
}

/**
 * Parse a streaming NDJSON buffer into completed chunks plus the trailing
 * partial line.
 *
 * Ollama emits one JSON object per line, but a network read can split a line
 * anywhere — including mid-multibyte-character. Returning the remainder lets
 * the caller carry it into the next read instead of dropping or corrupting a
 * token, which is the usual source of "the last word is missing" bugs.
 * Malformed lines are skipped rather than thrown, so one bad line cannot kill
 * an otherwise healthy stream.
 */
export function parseChatStreamBuffer(buffer: string): {
  chunks: OllamaChatChunk[];
  rest: string;
} {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const chunks: OllamaChatChunk[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      chunks.push(JSON.parse(trimmed) as OllamaChatChunk);
    } catch {
      // Skip: a partial or malformed line must not abort the stream.
    }
  }
  return { chunks, rest };
}

/** Extract the text a chunk contributes, if any. */
export function chunkText(chunk: OllamaChatChunk): string {
  return chunk.message?.content ?? "";
}
