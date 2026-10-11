import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => [] as Array<(event: { payload: unknown }) => void>);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.push(handler);
    return () => handlers.splice(handlers.indexOf(handler), 1);
  }),
}));

import { CloudTurnRefused, cloudHistory, historyHoldsSummary, streamCloudChat } from "./cloudAssistant";

/* The page side of a cloud turn. Rust is mocked at `invoke` and
   its events are played into the listener. */

const emit = (payload: Record<string, unknown>) => {
  for (const handler of [...handlers]) handler({ payload: { requestId: "req-1", ...payload } });
};

const result = {
  text: "Merhaba",
  blocks: [{ type: "text", text: "Merhaba" }],
  stop: "end_turn",
  refusalCategory: null,
  servedBy: "claude-opus-5-5",
  fallbackFrom: null,
  usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.00008 },
};

beforeEach(() => {
  invoke.mockReset();
  handlers.length = 0;
});

describe("cloud turns", () => {
  it("starts the turn with the conversation only, and hears it to the end", async () => {
    invoke.mockResolvedValueOnce({ accepted: true });
    const tokens: string[] = [];
    const bound = vi.fn();
    const turn = streamCloudChat(
      { provider: "anthropic" },
      "claude-opus-5-5",
      [{ role: "user", content: "Selam" }],
      { requestId: "req-1", onToken: (t) => tokens.push(t), onBound: bound },
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    emit({ kind: "bound", endpoint: "api.anthropic.com", model: "claude-opus-5-5", sentBytes: 512, masked: 1 });
    emit({ kind: "token", text: "Mer" });
    emit({ kind: "token", text: "haba", requestId: "other" });
    emit({ kind: "token", text: "haba" });
    emit({ kind: "done", result });

    await expect(turn).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("ai_chat_start", {
      request: {
        requestId: "req-1",
        target: { provider: "anthropic" },
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: "Selam" }],
      },
    });
    expect(tokens).toEqual(["Mer", "haba"]);
    expect(bound).toHaveBeenCalledWith({
      endpoint: "api.anthropic.com",
      model: "claude-opus-5-5",
      sentBytes: 512,
      masked: 1,
    });
    expect(handlers).toHaveLength(0);
  });

  it("rejects with the service's error code", async () => {
    invoke.mockResolvedValueOnce({ accepted: true });
    const turn = streamCloudChat({ provider: "anthropic" }, "claude-opus-5-5", [], { requestId: "req-1" });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    emit({ kind: "error", error: { code: "rate_limited", retryAfterSeconds: 30 } });

    await expect(turn).rejects.toEqual({ code: "rate_limited", retryAfterSeconds: 30 });
  });

  it("says why Rust would not start the turn", async () => {
    invoke.mockResolvedValueOnce({ accepted: false, reason: "busy" });

    await expect(
      streamCloudChat({ provider: "anthropic" }, "claude-opus-5-5", [], { requestId: "req-1" }),
    ).rejects.toBeInstanceOf(CloudTurnRefused);
    expect(handlers).toHaveLength(0);
  });

  it("asks Rust to stop when the turn is aborted", async () => {
    invoke.mockResolvedValue({ accepted: true });
    const controller = new AbortController();
    const turn = streamCloudChat({ provider: "anthropic" }, "claude-opus-5-5", [], {
      requestId: "req-1",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    controller.abort();
    expect(invoke).toHaveBeenCalledWith("ai_chat_cancel", { requestId: "req-1" });
    emit({ kind: "error", error: { code: "cancelled" } });

    await expect(turn).rejects.toEqual({ code: "cancelled" });
  });

  it("never starts a turn stopped while it subscribes", async () => {
    invoke.mockResolvedValue(false);
    const controller = new AbortController();
    const turn = streamCloudChat({ provider: "anthropic" }, "claude-opus-5-5", [], {
      requestId: "req-1",
      signal: controller.signal,
    });
    controller.abort();

    await expect(turn).rejects.toEqual({ code: "cancelled" });
    expect(invoke).not.toHaveBeenCalledWith("ai_chat_start", expect.anything());
    expect(handlers).toHaveLength(0);
  });

  it("stops a turn whose Stop came while it was starting", async () => {
    let accept!: (value: unknown) => void;
    invoke.mockImplementation((command: string) =>
      command === "ai_chat_start"
        ? new Promise((resolve) => {
            accept = resolve;
          })
        : Promise.resolve(false),
    );
    const controller = new AbortController();
    const turn = streamCloudChat({ provider: "anthropic" }, "claude-opus-5-5", [], {
      requestId: "req-1",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("ai_chat_start", expect.anything()));

    controller.abort();
    accept({ accepted: true });

    // Once when Stop was pressed, once more after Rust took the turn.
    await vi.waitFor(() =>
      expect(invoke.mock.calls.filter(([command]) => command === "ai_chat_cancel")).toHaveLength(2),
    );
    emit({ kind: "error", error: { code: "cancelled" } });
    await expect(turn).rejects.toEqual({ code: "cancelled" });
  });
});

describe("the conversation a cloud turn sends", () => {
  const facts = {
    endpoint: "api.anthropic.com",
    masked: 0,
    servedBy: "claude-opus-5-5",
    fallbackFrom: null,
    sentBytes: 10,
    refusalCategory: "cyber",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
  };

  it("sends questions and answers, a Claude answer with its blocks", () => {
    const blocks = [{ type: "text", text: "Merhaba" }];
    expect(
      cloudHistory([
        { role: "system", content: "context" },
        { role: "user", content: "Selam" },
        { role: "assistant", content: "Merhaba", blocks, answeredBy: { endpoint: "e", model: "m" } },
        { role: "user", content: "Nasılsın" },
      ]),
    ).toEqual([
      { role: "user", content: "Selam" },
      { role: "assistant", content: "Merhaba", blocks },
      { role: "user", content: "Nasılsın" },
    ]);
  });

  it("leaves out a declined question with its decline, and begins at a question", () => {
    expect(
      cloudHistory([
        { role: "assistant", content: "trimmed start" },
        { role: "user", content: "Q1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "declined" },
        { role: "assistant", content: "", cloud: { ...facts, stop: "refusal" } },
        { role: "user", content: "Q2" },
      ]),
    ).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]);
  });

  it("sends a question that went out before exactly as it went", () => {
    expect(
      cloudHistory([
        { role: "user", content: "pw=hunter22", cloudSent: true, cloudContent: "pw=[masked token]" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "plain", cloudSent: true },
        { role: "assistant", content: "A2" },
        { role: "user", content: "new" },
      ]),
    ).toEqual([
      { role: "user", content: "pw=[masked token]", sent: true },
      { role: "assistant", content: "A1" },
      { role: "user", content: "plain", sent: true },
      { role: "assistant", content: "A2" },
      { role: "user", content: "new" },
    ]);
  });

  it("puts an investigation's summary before its question until the question went", () => {
    const history = [
      { role: "user" as const, content: "Q1", context: "SUMMARY" },
      { role: "assistant" as const, content: "A1" },
    ];
    expect(cloudHistory(history)).toEqual([
      { role: "user", content: "SUMMARY\n\nQ1" },
      { role: "assistant", content: "A1" },
    ]);
    expect(historyHoldsSummary(history)).toBe(true);
    // Once it went, it goes as it went, masked; still a summary.
    const sent = [{ ...history[0]!, cloudSent: true, cloudContent: "S[masked]\n\nQ1" }, history[1]!];
    expect(cloudHistory(sent)[0]).toEqual({ role: "user", content: "S[masked]\n\nQ1", sent: true });
    expect(historyHoldsSummary(sent)).toBe(true);
    expect(historyHoldsSummary([{ role: "user", content: "Q" }])).toBe(false);
  });

  it("puts Jarvis's memory and instructions first, before a summary, and is no summary itself", () => {
    const history = [{ role: "user" as const, content: "Q1", personal: "ME", context: "SUMMARY" }];
    expect(cloudHistory(history)).toEqual([{ role: "user", content: "ME\n\nSUMMARY\n\nQ1" }]);
    const alone = [{ role: "user" as const, content: "Q1", personal: "ME" }];
    expect(cloudHistory(alone)).toEqual([{ role: "user", content: "ME\n\nQ1" }]);
    expect(historyHoldsSummary(alone)).toBe(false);
  });

  it("leaves a declined question's summary out, so the history no longer holds one", () => {
    const history = [
      { role: "user" as const, content: "Q1", context: "SUMMARY", cloudSent: true, cloudContent: "SUMMARY\n\nQ1" },
      { role: "assistant" as const, content: "", cloud: { ...facts, stop: "refusal" as const } },
    ];
    expect(cloudHistory(history)).toEqual([]);
    expect(historyHoldsSummary(history)).toBe(false);
  });
});
