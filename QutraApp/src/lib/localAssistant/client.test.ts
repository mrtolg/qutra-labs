import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSISTANT_MODEL } from "@/domain/localAssistant";
import {
  AssistantBlockedError,
  AssistantTimeoutError,
  type AssistantStreamEvent,
  LocalAssistantClient,
} from "./client";

/* The network is out of the renderer, so these do not mock a
   server — they mock the IPC boundary. The strongest claims are still negative
   ones ("nothing is invoked"), asserted against a spy that records every call.

   What these cannot prove: that the Rust broker behaves correctly. That is
   covered by `cargo test` in `src-tauri/src/assistant/`, and neither suite
   should be quoted as evidence for the other. */

const ENABLED = {
  localAssistantEnabled: true,
  ollamaModel: DEFAULT_ASSISTANT_MODEL,
  ollamaContextTokens: 4096,
};

function lastRequestId(invoke: { mock: { calls: unknown[][] } }): string {
  const call = invoke.mock.calls.find(([c]) => c === "assistant_start");
  const args = call?.[1] as { request: { requestId: string } };
  return args.request.requestId;
}

/** Build a client whose event stream is driven by the test. */
function harness(
  invokeImpl: (command: string, args?: Record<string, unknown>) => unknown,
) {
  let handler: (event: AssistantStreamEvent) => void = () => {};
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) =>
    invokeImpl(command, args),
  );
  const client = new LocalAssistantClient({
    invokeImpl: invoke as never,
    listenImpl: async (_event, incoming) => {
      handler = incoming;
      return () => {};
    },
    availableImpl: () => true,
  });
  return { client, invoke, emit: (e: AssistantStreamEvent) => handler(e) };
}

/** The common case: the broker accepts, then the test drives the stream. */
const accepts = (command: string) =>
  command === "assistant_start"
    ? { accepted: true }
    : command === "assistant_cancel"
      ? { cancelled: true }
      : { status: "ready", models: [DEFAULT_ASSISTANT_MODEL] };

describe("nothing crosses the boundary while disabled", () => {
  it("checkHealth never invokes", async () => {
    const { client, invoke } = harness(accepts);

    const health = await client.checkHealth({
      ...ENABLED,
      localAssistantEnabled: false,
    });

    expect(health.status).toBe("disabled");
    expect(invoke, "a disabled assistant must not reach the broker").not.toHaveBeenCalled();
  });

  it("streamChat never invokes and refuses loudly", async () => {
    const { client, invoke } = harness(accepts);

    await expect(
      client.streamChat({ ...ENABLED, localAssistantEnabled: false }, [
        { role: "user", content: "hello" },
      ]),
    ).rejects.toBeInstanceOf(AssistantBlockedError);

    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("the renderer no longer chooses an endpoint", () => {
  it("sends no host, port or URL in any command", async () => {
    const { client, invoke, emit } = harness(accepts);

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    emit({ requestId: lastRequestId(invoke), kind: "done" });
    await run;

    await client.checkHealth(ENABLED);

    // Every argument that crosses IPC, flattened and searched.
    const payload = JSON.stringify(invoke.mock.calls);
    for (const forbidden of ["11434", "11435", "http://", "127.0.0.1", "localhost"]) {
      expect(payload, `renderer must not name ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("is unavailable rather than pretending in a browser build", async () => {
    const client = new LocalAssistantClient({
      invokeImpl: (async () => {
        throw new Error("should not be called");
      }) as never,
      availableImpl: () => false,
    });

    expect((await client.checkHealth(ENABLED)).status).toBe("unavailable");
    await expect(
      client.streamChat(ENABLED, [{ role: "user", content: "hi" }]),
    ).rejects.toBeInstanceOf(AssistantBlockedError);
  });
});

describe("streaming over events", () => {
  it("assembles tokens for its own request only", async () => {
    const { client, invoke, emit } = harness(accepts);
    const tokens: string[] = [];

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }], {
      onToken: (t) => tokens.push(t),
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const id = lastRequestId(invoke);

    emit({ requestId: id, kind: "token", text: "Hel" });
    // A stray event from an unrelated turn must be ignored entirely.
    emit({ requestId: "someone-else", kind: "token", text: "XXX" });
    emit({ requestId: id, kind: "token", text: "lo" });
    emit({ requestId: id, kind: "done" });

    expect(await run).toBe("Hello");
    expect(tokens).toEqual(["Hel", "lo"]);
  });

  it("passes model and context size to the broker", async () => {
    const { client, invoke, emit } = harness(accepts);

    const run = client.streamChat({ ...ENABLED, ollamaContextTokens: 8192 }, [
      { role: "user", content: "hi" },
    ]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    emit({ requestId: lastRequestId(invoke), kind: "done" });
    await run;

    const args = invoke.mock.calls.find(([c]) => c === "assistant_start")?.[1] as {
      request: { model: string; contextTokens: number };
    };
    expect(args.request.model).toBe(DEFAULT_ASSISTANT_MODEL);
    expect(args.request.contextTokens).toBe(8192);
  });

  it("keeps partial text when the broker reports a cancel", async () => {
    const { client, invoke, emit } = harness(accepts);
    const controller = new AbortController();

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }], {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const id = lastRequestId(invoke);

    emit({ requestId: id, kind: "token", text: "partial" });
    controller.abort();
    emit({ requestId: id, kind: "error", message: "cancelled" });

    // Stop is a normal ending, not an error.
    expect(await run).toBe("partial");
    // And it must stop the broker, not merely stop listening.
    expect(invoke.mock.calls.some(([c]) => c === "assistant_cancel")).toBe(true);
  });

  it("does not start a turn that was aborted while listen() was still registering", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async (command: string) =>
      command === "assistant_start"
        ? { accepted: true }
        : command === "assistant_cancel"
          ? { cancelled: true }
          : { status: "ready", models: [DEFAULT_ASSISTANT_MODEL] },
    );
    const client = new LocalAssistantClient({
      invokeImpl: invoke as never,
      listenImpl: async (_event, _incoming) => {
        await gate;
        return () => {};
      },
      availableImpl: () => true,
    });
    const controller = new AbortController();

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }], {
      signal: controller.signal,
    });
    controller.abort();
    release();

    await expect(run).resolves.toBe("");
    expect(invoke.mock.calls.some(([c]) => c === "assistant_start")).toBe(false);
    expect(invoke.mock.calls.some(([c]) => c === "assistant_cancel")).toBe(true);
  });

  it("surfaces a timeout as a distinct error", async () => {
    const { client, invoke, emit } = harness(accepts);

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    emit({
      requestId: lastRequestId(invoke),
      kind: "error",
      message: "timeout_first_token",
    });

    await expect(run).rejects.toBeInstanceOf(AssistantTimeoutError);
  });

  it("refuses a second turn when the broker says busy", async () => {
    const { client } = harness((command) =>
      command === "assistant_start"
        ? { accepted: false, reason: "busy" }
        : { cancelled: false },
    );

    await expect(
      client.streamChat(ENABLED, [{ role: "user", content: "hi" }]),
    ).rejects.toMatchObject({ reason: "busy" });
  });
});

describe("health reporting", () => {
  it("passes the broker's verdict through", async () => {
    for (const status of ["ready", "model_missing", "offline"] as const) {
      const { client } = harness(() => ({ status, models: [] }));
      expect((await client.checkHealth(ENABLED)).status).toBe(status);
    }
  });

  it("reports an error rather than throwing when IPC fails", async () => {
    const { client } = harness(() => {
      throw new Error("ipc exploded");
    });
    // A broken command must not take the settings screen down.
    expect((await client.checkHealth(ENABLED)).status).toBe("error");
  });
});

describe("tool calls and results reach the caller's handlers (ADR 0012)", () => {
  it("delivers a tool_call event to onToolCall with its callId and summary", async () => {
    const { client, invoke, emit } = harness(accepts);
    const seen: AssistantStreamEvent[] = [];

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }], {
      onToolCall: (event) => seen.push(event),
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const id = lastRequestId(invoke);

    emit({
      requestId: id,
      kind: "tool_call",
      callId: "req-1-tool-0",
      summary: "Run terminal command: whoami",
    });
    // A stray event from an unrelated turn must be ignored entirely.
    emit({ requestId: "someone-else", kind: "tool_call", callId: "x", summary: "x" });
    emit({ requestId: id, kind: "done" });
    await run;

    expect(seen).toEqual([
      {
        requestId: id,
        kind: "tool_call",
        callId: "req-1-tool-0",
        summary: "Run terminal command: whoami",
      },
    ]);
  });

  it("delivers a tool_result event to onToolResult with its callId and sessionId", async () => {
    const { client, invoke, emit } = harness(accepts);
    const seen: AssistantStreamEvent[] = [];

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }], {
      onToolResult: (event) => seen.push(event),
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const id = lastRequestId(invoke);

    emit({
      requestId: id,
      kind: "tool_result",
      callId: "req-1-tool-0",
      sessionId: "sess-9",
    });
    emit({ requestId: id, kind: "done" });
    await run;

    expect(seen).toEqual([
      { requestId: id, kind: "tool_result", callId: "req-1-tool-0", sessionId: "sess-9" },
    ]);
  });
});

describe("each turn names where it was sent", () => {
  it("delivers its own bound event to onBound, and nobody else's", async () => {
    const { client, invoke, emit } = harness(accepts);
    const seen: { endpoint: string; model: string }[] = [];

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }], {
      onBound: (binding) => seen.push(binding),
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const id = lastRequestId(invoke);

    emit({ requestId: "someone-else", kind: "bound", endpoint: "http://127.0.0.1:11435", model: "x" });
    emit({ requestId: id, kind: "bound", endpoint: "http://127.0.0.1:11434", model: "qwen2.5:14b" });
    emit({ requestId: id, kind: "done" });
    await run;

    expect(seen).toEqual([{ endpoint: "http://127.0.0.1:11434", model: "qwen2.5:14b" }]);
  });

  it("sends the broker role and content only, never the stored recipient record", async () => {
    const { client, invoke, emit } = harness(accepts);

    const run = client.streamChat(
      ENABLED,
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          answeredBy: { endpoint: "http://127.0.0.1:11435", model: "qwen2.5:14b" },
        },
        { role: "user", content: "again" },
      ],
      {},
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    emit({ requestId: lastRequestId(invoke), kind: "done" });
    await run;

    const start = invoke.mock.calls.find(([c]) => c === "assistant_start");
    const sent = (start?.[1] as { request: { messages: unknown[] } }).request.messages;
    expect(sent).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ]);
  });
});

describe("approveTool (ADR 0012, Decision 2 — approval is per-call)", () => {
  it("forwards both ids and the decision to assistant_approve_tool", async () => {
    const { client, invoke } = harness((command) =>
      command === "assistant_approve_tool" ? { resolved: true } : accepts(command),
    );

    const result = await client.approveTool("req-1", "req-1-tool-0", true);

    expect(result).toEqual({ resolved: true });
    expect(invoke).toHaveBeenCalledWith("assistant_approve_tool", {
      requestId: "req-1",
      callId: "req-1-tool-0",
      approved: true,
    });
  });

  it("forwards a rejection just as faithfully as an approval", async () => {
    const { client, invoke } = harness((command) =>
      command === "assistant_approve_tool" ? { resolved: true } : accepts(command),
    );

    await client.approveTool("req-1", "req-1-tool-0", false);

    expect(invoke).toHaveBeenCalledWith("assistant_approve_tool", {
      requestId: "req-1",
      callId: "req-1-tool-0",
      approved: false,
    });
  });

  it("invokes nothing and reports unavailable rather than pretending in a browser build", async () => {
    const invoke = vi.fn();
    const client = new LocalAssistantClient({
      invokeImpl: invoke as never,
      availableImpl: () => false,
    });

    const result = await client.approveTool("req-1", "req-1-tool-0", true);

    expect(result).toEqual({ resolved: false });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("autoApproveReads rides the start payload (ADR 0012, Decision 2)", () => {
  it("defaults to false when the caller does not opt in", async () => {
    const { client, invoke, emit } = harness(accepts);

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    emit({ requestId: lastRequestId(invoke), kind: "done" });
    await run;

    const args = invoke.mock.calls.find(([c]) => c === "assistant_start")?.[1] as {
      request: { autoApproveReads: boolean };
    };
    expect(args.request.autoApproveReads).toBe(false);
  });

  it("passes an explicit opt-in through", async () => {
    const { client, invoke, emit } = harness(accepts);

    const run = client.streamChat({ ...ENABLED, autoApproveReads: true }, [
      { role: "user", content: "hi" },
    ]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    emit({ requestId: lastRequestId(invoke), kind: "done" });
    await run;

    const args = invoke.mock.calls.find(([c]) => c === "assistant_start")?.[1] as {
      request: { autoApproveReads: boolean };
    };
    expect(args.request.autoApproveReads).toBe(true);
  });
});

describe("agentToolsEnabled rides the start payload (ADR 0012)", () => {
  it("defaults to false when the caller does not opt in", async () => {
    const { client, invoke, emit } = harness(accepts);

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    emit({ requestId: lastRequestId(invoke), kind: "done" });
    await run;

    const args = invoke.mock.calls.find(([c]) => c === "assistant_start")?.[1] as {
      request: { agentToolsEnabled: boolean };
    };
    expect(args.request.agentToolsEnabled).toBe(false);
  });

  it("passes an explicit opt-in through under the exact wire name the broker expects", async () => {
    const { client, invoke, emit } = harness(accepts);

    const run = client.streamChat({ ...ENABLED, agentToolsEnabled: true }, [
      { role: "user", content: "hi" },
    ]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    emit({ requestId: lastRequestId(invoke), kind: "done" });
    await run;

    const args = invoke.mock.calls.find(([c]) => c === "assistant_start")?.[1] as {
      request: { agentToolsEnabled: boolean };
    };
    expect(args.request.agentToolsEnabled).toBe(true);
  });
});

describe("a terminal tool-path error settles with partial text instead of discarding it", () => {
  it.each([
    "approval_rejected",
    "unknown_tool",
    "unsolicited_tool",
    "tool_failed",
    "too_many_steps",
    "private_tools_consent_required",
    "model_tools_unsupported",
    "model_cloud_backed",
    "internal",
  ])("resolves with the prose that streamed before a %s error, and reports it via onError", async (code) => {
    const { client, invoke, emit } = harness(accepts);
    const errors: unknown[] = [];

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }], {
      onError: (error) => errors.push(error),
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const id = lastRequestId(invoke);

    emit({ requestId: id, kind: "token", text: "Here is what I found: " });
    emit({ requestId: id, kind: "error", message: code });

    // The prose survives -- it is not thrown away with the failure.
    await expect(run).resolves.toBe("Here is what I found: ");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AssistantBlockedError);
    expect((errors[0] as InstanceType<typeof AssistantBlockedError>).reason).toBe(code);
  });

  it("never calls onError for a cancelled turn -- Stop is a normal ending", async () => {
    const { client, invoke, emit } = harness(accepts);
    const errors: unknown[] = [];
    const controller = new AbortController();

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }], {
      signal: controller.signal,
      onError: (error) => errors.push(error),
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const id = lastRequestId(invoke);

    emit({ requestId: id, kind: "token", text: "partial" });
    controller.abort();
    emit({ requestId: id, kind: "error", message: "cancelled" });

    expect(await run).toBe("partial");
    expect(errors).toEqual([]);
  });

  it("still rejects (does not call onError) for a timeout code -- a deadline is not a tool-path outcome", async () => {
    const { client, invoke, emit } = harness(accepts);
    const errors: unknown[] = [];

    const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }], {
      onError: (error) => errors.push(error),
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    emit({
      requestId: lastRequestId(invoke),
      kind: "error",
      message: "timeout_first_token",
    });

    await expect(run).rejects.toBeInstanceOf(AssistantTimeoutError);
    expect(errors).toEqual([]);
  });
});

describe("timeout classification (approval and turn timeouts are timeouts, not blocks)", () => {
  it.each(["timeout_turn", "approval_timeout"])(
    "surfaces %s as AssistantTimeoutError, not AssistantBlockedError",
    async (code) => {
      const { client, invoke, emit } = harness(accepts);

      const run = client.streamChat(ENABLED, [{ role: "user", content: "hi" }]);
      await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
      emit({ requestId: lastRequestId(invoke), kind: "error", message: code });

      await expect(run).rejects.toBeInstanceOf(AssistantTimeoutError);
    },
  );
});
