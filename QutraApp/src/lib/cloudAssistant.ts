import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AssistantMessage } from "@/domain/localAssistant";
import type { WebSource } from "@/domain/conversations";
import type { AiError, AiTarget } from "@/lib/aiConnections";

/* Jarvis through a cloud connection. Rust reads the key, masks
   secrets in the user's messages, sends the conversation to the
   address the key was saved for and streams the answer on `ai://stream`
   (src-tauri/src/ai/chat.rs). The page sends the conversation; no project
   context goes, and an investigation's summary only after the consent card
   (see cloudConsent.ts). */

export const CLOUD_STREAM_EVENT = "ai://stream";

export interface CloudUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated from a dated price table; null for a model not in it. */
  costUsd: number | null;
}

export type CloudStop = "end_turn" | "max_tokens" | "refusal" | "other";

export interface CloudTurnResult {
  text: string;
  /** Claude's content blocks, saved so the next turn echoes them unchanged. */
  blocks: unknown[] | null;
  stop: CloudStop;
  refusalCategory: string | null;
  /** The model that produced the answer. */
  servedBy: string | null;
  /** The model that declined, when another one answered. */
  fallbackFrom: string | null;
  usage: CloudUsage | null;
  /** On a web-enabled turn: the pages the answer cites, or else the pages
      the search found. Absent when the internet was off. */
  sources?: WebSource[];
}

/** A message as it goes to Rust: user and assistant only. */
export interface CloudMessage {
  role: "user" | "assistant";
  content: string;
  blocks?: unknown[];
  /** A question that went out before: its text is what went out then,
      masked, and Rust sends it as it is. */
  sent?: boolean;
}

/** A message as it goes to the cloud, with the one it came from. */
interface CloudEntry {
  out: CloudMessage;
  from: AssistantMessage;
}

/**
 * The conversation as it goes to the cloud: questions and answers, a Claude
 * answer with its blocks. A declined question is left out with its decline,
 * since sent again it would be declined again; and a conversation trimmed at
 * its start begins at its first question.
 */
function cloudEntries(messages: readonly AssistantMessage[]): CloudEntry[] {
  const out: CloudEntry[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant" && m.cloud?.stop === "refusal") {
      while (out.at(-1)?.out.role === "user") out.pop();
      continue;
    }
    // An answer without text (cut off while thinking) has nothing to echo.
    if (m.role === "assistant" && !m.content) continue;
    // A question sent before goes out exactly as it did then, so a later
    // change to the masking never rewrites the conversation's past.
    if (m.role === "user" && m.cloudSent) {
      out.push({
        out: { role: "user", content: m.cloudContent ?? m.content, sent: true },
        from: m,
      });
      continue;
    }
    // A question about an investigation carries its summary first, and
    // the first one Jarvis's memory and instructions before that.
    if (m.role === "user" && (m.context || m.personal)) {
      const content = [m.personal, m.context, m.content].filter(Boolean).join("\n\n");
      out.push({ out: { role: "user", content }, from: m });
      continue;
    }
    out.push({
      out: m.blocks?.length
        ? { role: m.role, content: m.content, blocks: m.blocks }
        : { role: m.role, content: m.content },
      from: m,
    });
  }
  while (out[0]?.out.role === "assistant") out.shift();
  return out;
}

export function cloudHistory(messages: readonly AssistantMessage[]): CloudMessage[] {
  return cloudEntries(messages).map((entry) => entry.out);
}

/** Whether the conversation as it goes to the cloud carries an
    investigation's summary. A declined question is left out with its
    summary, so the next question about the investigation carries it again. */
export function historyHoldsSummary(messages: readonly AssistantMessage[]): boolean {
  return cloudEntries(messages).some(
    (entry) => entry.from.role === "user" && Boolean(entry.from.context),
  );
}

interface CloudEvent {
  requestId: string;
  kind: "bound" | "token" | "thinking" | "searching" | "retrying" | "fallback" | "done" | "error";
  text?: string;
  endpoint?: string;
  model?: string;
  sentBytes?: number;
  masked?: number;
  sentText?: string;
  seconds?: number;
  from?: string;
  to?: string;
  result?: CloudTurnResult;
  error?: AiError;
}

/** Rust would not start the turn: `busy`, `request_too_large`, ... */
export class CloudTurnRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CloudTurnRefused";
  }
}

export interface CloudBound {
  /** The host the conversation goes to. */
  endpoint: string;
  model: string;
  /** How many bytes of conversation went out. */
  sentBytes: number;
  /** How many secrets Rust masked in what went out. */
  masked: number;
  /** The question as it went out, masked; kept so later turns send it so. */
  sentText?: string;
  /** The connection it went through: `anthropic` or an OpenAI-compatible
      preset; set by the page, which knows the turn's target. */
  provider?: string;
}

export interface CloudStreamOptions {
  requestId: string;
  signal?: AbortSignal;
  onBound?: (bound: CloudBound) => void;
  onToken?: (text: string) => void;
  onThinking?: () => void;
  /** Claude began a web search or page fetch of its own. */
  onSearching?: () => void;
  /** The conversation's "İnternet" switch: Claude may search and read pages.
      Rust refuses it for any connection but Claude's. */
  webAccess?: boolean;
  onRetrying?: (seconds: number) => void;
  onFallback?: (from: string, to: string) => void;
}

/**
 * Run one cloud turn. Resolves with the finished turn; rejects with an
 * `AiError` (`{ code }`, `cancelled` after an abort) or `CloudTurnRefused`.
 */
export async function streamCloudChat(
  target: AiTarget,
  model: string,
  messages: CloudMessage[],
  options: CloudStreamOptions,
): Promise<CloudTurnResult> {
  const { requestId, signal } = options;
  if (signal?.aborted) throw { code: "cancelled" } satisfies AiError;

  let settle!: { resolve: (result: CloudTurnResult) => void; reject: (error: unknown) => void };
  const finished = new Promise<CloudTurnResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // An error event can beat the start reply; settled before it is awaited,
  // the turn must not count as an unhandled rejection.
  finished.catch(() => {});
  // Installed before anything is awaited, so a Stop during setup is never
  // lost (ADR 0013). Rust answers a cancel for a turn it does not run with
  // false.
  const onAbort = () => {
    invoke("ai_chat_cancel", { requestId }).catch(() => {
      // The turn may have ended a moment earlier; nothing to stop.
    });
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let unlisten = () => {};
  try {
    // Listen before starting, so no event of this turn can be missed.
    unlisten = await listen<CloudEvent>(CLOUD_STREAM_EVENT, ({ payload }) => {
      if (payload.requestId !== requestId) return;
      switch (payload.kind) {
        case "bound":
          options.onBound?.({
            endpoint: payload.endpoint ?? "",
            model: payload.model ?? model,
            sentBytes: payload.sentBytes ?? 0,
            masked: payload.masked ?? 0,
            ...(payload.sentText !== undefined ? { sentText: payload.sentText } : {}),
          });
          break;
        case "token":
          if (payload.text) options.onToken?.(payload.text);
          break;
        case "thinking":
          options.onThinking?.();
          break;
        case "searching":
          options.onSearching?.();
          break;
        case "retrying":
          options.onRetrying?.(payload.seconds ?? 0);
          break;
        case "fallback":
          options.onFallback?.(payload.from ?? "", payload.to ?? "");
          break;
        case "done":
          if (payload.result) settle.resolve(payload.result);
          else settle.reject({ code: "unexpected" } satisfies AiError);
          break;
        case "error":
          settle.reject(payload.error ?? ({ code: "unexpected" } satisfies AiError));
          break;
      }
    });
    // Stopped while subscribing: the turn never starts.
    if (signal?.aborted) throw { code: "cancelled" } satisfies AiError;
    const start = await invoke<{ accepted: boolean; reason?: string }>("ai_chat_start", {
      request: {
        requestId,
        target,
        model,
        messages,
        ...(options.webAccess ? { webAccess: true } : {}),
      },
    });
    if (!start.accepted) throw new CloudTurnRefused(start.reason ?? "refused");
    // Stopped while starting: the first cancel may have reached Rust before
    // the turn did.
    if (signal?.aborted) onAbort();
    return await finished;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unlisten();
  }
}
