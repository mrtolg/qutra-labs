import { isTauriRuntime } from "@/lib/runtime";
import type { AssistantGateInput, AssistantMessage } from "@/domain/localAssistant";

/* ============================================================
   Qutra IPC adapter (ADR 0010).

   This used to speak HTTP to Ollama directly from the renderer. It no longer
   does, and cannot: there is no URL in this file. It sends intent over three
   Tauri commands and consumes a stream of events.

   The endpoint, the timeouts, the single-flight rule and cancellation all live
   in `src-tauri/src/assistant/`. A webview is not a trust boundary, so the
   rules that matter are enforced where the renderer cannot reach them.

   `invoke` and `listen` are injected so the adapter is unit-testable without a
   Tauri runtime — the transport is mocked, never the policy.
   ============================================================ */

export type AssistantStatus =
  | "disabled"
  /** Enabled, but not probed yet — probing is opt-in, never on mount. */
  | "unknown"
  | "connecting"
  | "ready"
  | "model_missing"
  /** Qutra's local engine (ADR 0016) is not installed yet. */
  | "engine_missing"
  /** The model's vision layers share its file: a one-time copy is needed. */
  | "needs_prepare"
  /** The pinned engine does not run this model's architecture. */
  | "unsupported"
  | "offline"
  /** No native runtime: a browser build cannot reach the broker. */
  | "unavailable"
  | "error";

export interface AssistantHealth {
  status: AssistantStatus;
  models: string[];
  detail?: string;
  /** Origin Rust selected. Never chosen by this client. */
  endpoint?: string;
  /** Model this probe was asked about — not a silent substitute. */
  selectedModel?: string;
}

/** One local model and whether its chat template can call tools. Mirrors
    the Rust `ModelInfo` in `src-tauri/src/assistant/commands.rs`. */
export interface AssistantModelInfo {
  name: string;
  /** `completion`, plus `tools` when the model's template names them. */
  capabilities: string[];
  /** `true`/`false` from the model's chat template, `null` when it has none.
      Unknown is deliberately not folded into `false`: a model without a
      template may still call tools, and the picker says "unknown". */
  tools: boolean | null;
}

/** Mirrors the Rust `ModelsReport`. Same status vocabulary as
    `AssistantHealth`, so both surfaces are handled the same way. */
export interface AssistantModels {
  status: AssistantStatus;
  models: AssistantModelInfo[];
  detail?: string;
  endpoint?: string;
}

/** One `assistant://stream` payload. Mirrors the Rust `StreamEvent`. */
export interface AssistantStreamEvent {
  requestId: string;
  kind: "token" | "status" | "done" | "error" | "tool_call" | "tool_result" | "bound";
  text?: string;
  status?: string;
  message?: string;
  /** Present on `tool_call` and `tool_result`. Synthesized by the broker from
      the request id and step -- never taken from model output, so a stale card
      cannot resolve the call that replaced it. */
  callId?: string;
  /** The exact proposed action, plain text, shown to the user verbatim on a
      `tool_call`. Never rendered as markup: a proposal must not be able to
      disguise what it is asking for. */
  summary?: string;
  /** Present on a `tool_result` for `terminal_run` -- the PTY session the
      agent used, so the UI can point at it. */
  sessionId?: string;
  /** Present on `bound`: the origin this turn is sent to, chosen by Rust. */
  endpoint?: string;
  /** Present on `bound`: the model this turn is bound to. */
  model?: string;
  /** Present on `tool_call`: the proposed action as facts, so
      the card shows the exact command without parsing `summary`. */
  action?: ApprovalAction;
}

/** The proposed action as facts, from Rust's `tools::ApprovalAction`. Nothing
    in it is an assessment: scope and effects are not judged, and the card
    must say so rather than imply them. */
export type ApprovalAction =
  | { kind: "terminal_run"; sessionId: string | null; command: string }
  | {
      kind: "launch_tool";
      installationId: string;
      /** Null when the identity gate refused the installation. */
      displayName: string | null;
      argsText: string;
      identity:
        | { state: "verified"; sha256: string; riskTier: string }
        | { state: "blocked"; reason: string };
    }
  | { kind: "read_context"; contextKind: string };

/** Where one turn's conversation went: what Rust bound, not what the last
    health probe saw (security review). */
export interface TurnBinding {
  endpoint: string;
  model: string;
}

export const ASSISTANT_STREAM_EVENT = "assistant://stream";

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type ListenFn = (
  event: string,
  handler: (payload: AssistantStreamEvent) => void,
) => Promise<() => void>;

export interface LocalAssistantClientOptions {
  invokeImpl?: InvokeFn;
  listenImpl?: ListenFn;
  /** Override runtime detection in tests. */
  availableImpl?: () => boolean;
}

/** Thrown when the broker refused before doing any work. */
export class AssistantBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`local_assistant_blocked:${reason}`);
    this.name = "AssistantBlockedError";
  }
}

/** A deadline elapsed in the broker. Distinct from Stop, a normal outcome. */
export class AssistantTimeoutError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AssistantTimeoutError";
  }
}

const TIMEOUT_CODES = new Set([
  "timeout_health",
  "timeout_first_token",
  "timeout_total",
  // A turn that ran out of its overall budget, and a proposed tool call nobody
  // answered, are both deadlines -- not the broker refusing to start work.
  "timeout_turn",
  "approval_timeout",
]);

export class LocalAssistantClient {
  private readonly invokeImpl?: InvokeFn;
  private readonly listenImpl?: ListenFn;
  private readonly availableImpl: () => boolean;

  constructor(options: LocalAssistantClientOptions = {}) {
    this.invokeImpl = options.invokeImpl;
    this.listenImpl = options.listenImpl;
    this.availableImpl = options.availableImpl ?? isTauriRuntime;
  }

  available(): boolean {
    return this.availableImpl();
  }

  private async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (this.invokeImpl) return this.invokeImpl<T>(command, args);
    // Imported lazily so a browser build never pulls the Tauri API in.
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }

  private async listen(
    handler: (payload: AssistantStreamEvent) => void,
  ): Promise<() => void> {
    if (this.listenImpl) return this.listenImpl(ASSISTANT_STREAM_EVENT, handler);
    const { listen } = await import("@tauri-apps/api/event");
    const un = await listen<AssistantStreamEvent>(ASSISTANT_STREAM_EVENT, (e) =>
      handler(e.payload),
    );
    return un;
  }

  /**
   * Health probe. Only ever called on an explicit user action.
   *
   * A stopped lab is an expected state, not an exception, so this resolves with
   * a status rather than throwing.
   */
  async checkHealth(
    config: AssistantGateInput & { ollamaModel: string },
  ): Promise<AssistantHealth> {
    // The opt-in is checked here *and* in the broker. This copy exists so a
    // disabled assistant does not even cross the IPC boundary; the broker's
    // copy is the one that actually enforces it.
    if (!config.localAssistantEnabled) {
      return { status: "disabled", models: [] };
    }
    if (!this.available()) {
      return { status: "unavailable", models: [], detail: "no_native_runtime" };
    }

    try {
      return await this.invoke<AssistantHealth>("assistant_health", {
        enabled: true,
        model: config.ollamaModel,
      });
    } catch (caught) {
      return { status: "error", models: [], detail: String(caught) };
    }
  }

  /**
   * The local models with what each can do, read by Rust from the models'
   * own headers (ADR 0016). Only the model picker calls this.
   *
   * Resolves with a status rather than throwing, exactly like `checkHealth`:
   * a stopped lab is an expected state. In a browser build it reports
   * `unavailable` with an empty list -- never a fabricated one, matching what
   * `browserBridge` does everywhere else.
   */
  async listModels(config: AssistantGateInput): Promise<AssistantModels> {
    if (!config.localAssistantEnabled) {
      return { status: "disabled", models: [] };
    }
    if (!this.available()) {
      return { status: "unavailable", models: [], detail: "no_native_runtime" };
    }

    try {
      return await this.invoke<AssistantModels>("assistant_models", {
        enabled: true,
      });
    } catch (caught) {
      return { status: "error", models: [], detail: String(caught) };
    }
  }

  /**
   * Run one streamed turn, invoking `onToken` per fragment.
   *
   * Stop (`options.signal`) cancels in the broker, not just locally: aborting
   * only the listener would leave the model generating with nobody reading.
   * Returns whatever text arrived, which after a Stop is the partial answer.
   */
  async streamChat(
    config: AssistantGateInput & {
      ollamaModel: string;
      ollamaContextTokens: number;
      /** Opt-in, default off. Only ever weakens the gate for the read-only
          `read_context` tool -- the broker refuses to let it affect a
          side-effecting one (ADR 0012, Decision 2). */
      autoApproveReads?: boolean;
      /** Opt-in, default off (ADR 0012). Turns the assistant from an
          answerer into an agent that can *propose* a tool call at all. Sent
          on the wire as `agentToolsEnabled` -- an exact spelling the broker's
          `#[serde(default)]` field matches; the broker also requires Private
          Lab consent, so this alone is never sufficient. */
      agentToolsEnabled?: boolean;
    },
    messages: AssistantMessage[],
    options: {
      signal?: AbortSignal;
      /** The turn id, when the caller saves it with the conversation.
          Correlation only: it grants nothing. */
      requestId?: string;
      onToken?: (text: string) => void;
      /** Rust bound this turn to an origin and model. Arrives before any
          token, so the recipient can be shown while the answer streams. */
      onBound?: (binding: TurnBinding) => void;
      /** A tool the model wants to run. The turn is paused until
          `approveTool` answers, or the broker's deadline expires. */
      onToolCall?: (event: AssistantStreamEvent) => void;
      /** The outcome of a tool the user approved. */
      onToolResult?: (event: AssistantStreamEvent) => void;
      /** A terminal error arrived after the turn may already have streamed
          prose (a rejected or unrecognized tool call, a tool that failed to
          run, too many steps, ...). `streamChat` still *resolves* with
          whatever text arrived -- see the `kind === "error"` branch below --
          so this exists purely to let the caller show what went wrong
          without losing that text. Never called for `cancelled` (a normal
          Stop, not an error) or for a timeout code, which still rejects. */
      onError?: (error: AssistantBlockedError) => void;
    } = {},
  ): Promise<string> {
    if (!config.localAssistantEnabled) {
      throw new AssistantBlockedError("disabled");
    }
    if (!this.available()) {
      throw new AssistantBlockedError("unavailable");
    }

    const requestId =
      options.requestId ??
      globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random()}`;

    let full = "";
    let settle: ((value: string) => void) | null = null;
    let fail: ((error: unknown) => void) | null = null;

    const finished = new Promise<string>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    // Per-call generation: abort flips this and it is never written back.
    // A shared resettable boolean is how the PTY attach leak happened.
    const op = { live: true };
    const onAbort = () => {
      op.live = false;
      void this.invoke<{ cancelled: boolean }>("assistant_cancel", { requestId }).catch(
        () => {
          // The turn may have finished a moment earlier; nothing to stop.
        },
      );
    };

    if (options.signal?.aborted) {
      return "";
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let unlisten = () => {};
    try {
      // Subscribe before starting, so a fast first token cannot be missed.
      // The abort listener is already installed: aborting during this
      // await must not call assistant_start.
      unlisten = await this.listen((event) => {
        // Events are broadcast; ignore anything belonging to another turn.
        if (event.requestId !== requestId) return;

        if (event.kind === "token" && event.text) {
          full += event.text;
          options.onToken?.(event.text);
          return;
        }
        if (event.kind === "bound") {
          if (event.endpoint && event.model) {
            options.onBound?.({ endpoint: event.endpoint, model: event.model });
          }
          return;
        }
        if (event.kind === "tool_call") {
          options.onToolCall?.(event);
          return;
        }
        if (event.kind === "tool_result") {
          options.onToolResult?.(event);
          return;
        }
        if (event.kind === "done") {
          settle?.(full);
          return;
        }
        if (event.kind === "error") {
          const code = event.message ?? "internal";
          // Stop is a normal ending: keep what already arrived.
          if (code === "cancelled") {
            settle?.(full);
            return;
          }
          // A deadline elapsing is not a tool-path outcome -- it stays a
          // rejection so a caller can tell "the turn ran out of time" apart
          // from "the turn ended with a terminal tool/turn error" without
          // inspecting the code.
          if (TIMEOUT_CODES.has(code)) {
            fail?.(new AssistantTimeoutError(code));
            return;
          }
          // Every other terminal code (an unknown-tool refusal, a rejected or
          // failed tool call, too many steps, a missing consent, ...) used to
          // reject here, which threw away `full` -- including any prose that
          // streamed *before* the tool call that triggered it. Settling with
          // `full` keeps that prose in the transcript; `onError` is the
          // caller's separate channel for showing what went wrong, so the
          // failure stays visible instead of being silently swallowed by a
          // resolved promise that looks identical to a clean answer.
          options.onError?.(new AssistantBlockedError(code));
          settle?.(full);
        }
      });

      if (!op.live || options.signal?.aborted) {
        return "";
      }

      const outcome = await this.invoke<{ accepted: boolean; reason?: string }>(
        "assistant_start",
        {
          request: {
            requestId,
            enabled: true,
            model: config.ollamaModel,
            contextTokens: config.ollamaContextTokens,
            autoApproveReads: config.autoApproveReads ?? false,
            agentToolsEnabled: config.agentToolsEnabled ?? false,
            // Role and content only: a stored answer also records where it
            // was sent, which is for the user, never for the model.
            messages: messages.map(({ role, content }) => ({ role, content })),
          },
        },
      );
      if (!op.live || options.signal?.aborted) {
        return "";
      }
      if (!outcome.accepted) {
        throw new AssistantBlockedError(outcome.reason ?? "internal");
      }
      return await finished;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      unlisten();
    }
  }

  /**
   * Answer a pending tool-call approval.
   *
   * Both ids are sent because the broker matches on both: `requestId` alone
   * would let a card left over from an earlier turn resolve whatever is
   * pending now. A rejection is forwarded as faithfully as an approval -- the
   * broker ends the turn with `approval_rejected` rather than silently
   * skipping the call.
   *
   * A browser build has no broker to answer, so this reports an unresolved
   * approval instead of pretending one happened.
   */
  async approveTool(
    requestId: string,
    callId: string,
    approved: boolean,
  ): Promise<{ resolved: boolean }> {
    if (!this.available()) return { resolved: false };
    return this.invoke<{ resolved: boolean }>("assistant_approve_tool", {
      requestId,
      callId,
      approved,
    });
  }
}

/** Shared instance for the app; tests construct their own with mocks. */
export const localAssistant = new LocalAssistantClient();
