import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invoke = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => [] as Array<(event: { payload: unknown }) => void>);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.push(handler);
    return () => {
      handlers.splice(handlers.indexOf(handler), 1);
    };
  }),
}));
vi.mock("@/lib/localAssistant/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/localAssistant/client")>();
  return {
    ...actual,
    localAssistant: {
      available: vi.fn().mockReturnValue(true),
      checkHealth: vi.fn().mockResolvedValue({ status: "ready", models: [] }),
      listModels: vi.fn().mockResolvedValue({ status: "unavailable", models: [] }),
      streamChat: vi.fn(),
      approveTool: vi.fn().mockResolvedValue({ resolved: true }),
    },
  };
});

import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import { localAssistant } from "@/lib/localAssistant/client";
import { WorkspaceSchema } from "@/domain/types";
import { createEngagement } from "@/services/appService";
import { useUi } from "@/state/ui";
import { LocalAssistantChat } from "./LocalAssistantChat";

/* Jarvis talking through Claude. Rust is mocked at `invoke` and
   its `ai://stream` events are played into the listener; no key is read and
   nothing leaves the test. */

Element.prototype.scrollTo = vi.fn();

type Status = { present: boolean; last4: string | null; baseUrl: string | null };
const KEY: Status = { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" };
type Started = { requestId: string; target: unknown; model: string; messages: unknown[] };

/** A fake Rust side: the key status, and every turn it was asked to start. */
function rust(key: Status = KEY) {
  const started: Started[] = [];
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "ai_key_has":
        return key;
      case "ai_chat_start":
        started.push(args.request as Started);
        return { accepted: true };
      case "ai_chat_cancel":
        return undefined;
      default:
        throw new Error(`unexpected ${command}`);
    }
  });
  return started;
}

/** Play one event of the newest turn into the page. */
async function emit(started: Started[], payload: Record<string, unknown>) {
  const requestId = started.at(-1)!.requestId;
  await act(async () => {
    for (const handler of [...handlers]) handler({ payload: { requestId, ...payload } });
  });
}

const result = (overrides: Record<string, unknown> = {}) => ({
  text: "Merhaba",
  blocks: [
    { type: "thinking", thinking: "plan", signature: "sig" },
    { type: "text", text: "Merhaba" },
  ],
  stop: "end_turn",
  refusalCategory: null,
  servedBy: "claude-opus-5-5",
  fallbackFrom: null,
  usage: {
    inputTokens: 1200,
    outputTokens: 30,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.0054,
  },
  ...overrides,
});

const BOUND = { kind: "bound", endpoint: "api.anthropic.com", model: "claude-opus-5-5", sentBytes: 2150 };

function seedDb(prefs: Record<string, unknown> = {}) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({
    aiProvider: "anthropic",
    localAssistantEnabled: false,
    assistantContextEnabled: true,
    ...prefs,
  });
  setDbForTesting(db);
  // A project the local context would describe: none of it may go out.
  db.collection("workspaces").put(
    WorkspaceSchema.parse({
      id: "ws-1",
      name: "secret-project",
      color: "#37d6e0",
      purpose: "Internal red-team notes.",
      type: "software",
      status: "active",
      localPath: "C:\\work\\secret-project",
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
    }),
  );
  return db;
}

async function ask(started: Started[], text: string) {
  const count = started.length;
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Message to Jarvis"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(started).toHaveLength(count + 1));
}

const lastSaved = () => getDb().collection("conversations").getAll()[0]?.messages.at(-1);

beforeEach(() => {
  invoke.mockReset();
  handlers.length = 0;
  useUi.setState({ settingsSection: null });
  setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
});

afterEach(() => {
  resetBridgeForTesting();
  setDbForTesting(null);
  vi.clearAllMocks();
});

describe("Jarvis through Claude", () => {
  it("sends the conversation only, and keeps the answer with its blocks and facts", async () => {
    seedDb();
    const started = rust();
    render(<LocalAssistantChat />);
    expect(await screen.findByText("Sends the conversation only · Claude (Anthropic)")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-live-endpoint")).toHaveTextContent(
      "Claude Opus 5.5",
    );

    await ask(started, "Selam");

    expect(started[0]).toMatchObject({
      target: { provider: "anthropic" },
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "Selam" }],
    });
    expect(JSON.stringify(started[0])).not.toMatch(/secret-project|red-team/);

    await emit(started, BOUND);
    expect(screen.getByTestId("assistant-cloud-bound")).toHaveTextContent(
      "Sent: Claude (Anthropic) · api.anthropic.com · 2.1 KB",
    );
    await emit(started, { kind: "token", text: "Merhaba" });
    await emit(started, { kind: "done", result: result() });

    expect(await screen.findByText("Merhaba")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-cloud-meta")).toHaveTextContent(
      "Answered by claude-opus-5-5 · Sent: Claude (Anthropic) · api.anthropic.com · 2.1 KB · ≈ $0.0054 · 1,200 in · 30 out",
    );
    await waitFor(() =>
      expect(lastSaved()).toMatchObject({
        role: "assistant",
        content: "Merhaba",
        blocks: result().blocks,
        cloud: {
          endpoint: "api.anthropic.com",
          provider: "anthropic",
          masked: 0,
          servedBy: "claude-opus-5-5",
          sentBytes: 2150,
        },
      }),
    );
    // Ollama is not asked anything while Jarvis talks through the cloud.
    expect(vi.mocked(localAssistant.checkHealth)).not.toHaveBeenCalled();
    expect(vi.mocked(localAssistant.streamChat)).not.toHaveBeenCalled();
  });

  it("says how many secrets Rust masked in what went out", async () => {
    seedDb();
    const started = rust();
    render(<LocalAssistantChat />);
    await ask(started, "my password=hunter22");

    await emit(started, { ...BOUND, masked: 1, sentText: "my password=[masked password]" });
    expect(screen.getByTestId("assistant-cloud-bound")).toHaveTextContent(
      "Sent: Claude (Anthropic) · api.anthropic.com · 2.1 KB · 1 secret(s) masked",
    );
    await emit(started, { kind: "token", text: "Tamam" });
    await emit(started, { kind: "done", result: result() });

    expect(await screen.findByTestId("assistant-cloud-meta")).toHaveTextContent(
      "· 1 secret(s) masked",
    );
    await waitFor(() => expect(lastSaved()?.cloud).toMatchObject({ masked: 1 }));
    // The question as it went out is kept, and sent so on the next turn,
    // whatever the masking does by then.
    const question = () =>
      getDb().collection("conversations").getAll()[0]?.messages.find((m) => m.role === "user");
    await waitFor(() =>
      expect(question()).toMatchObject({
        content: "my password=hunter22",
        cloudSent: true,
        cloudContent: "my password=[masked password]",
      }),
    );

    await ask(started, "Devam");
    expect(started[1]!.messages[0]).toEqual({
      role: "user",
      content: "my password=[masked password]",
      sent: true,
    });
    expect(started[1]!.messages.at(-1)).toEqual({ role: "user", content: "Devam" });
  });

  it("names the model that answered when another took over", async () => {
    seedDb();
    const started = rust();
    render(<LocalAssistantChat />);
    await ask(started, "Soru");

    await emit(started, BOUND);
    await emit(started, { kind: "fallback", from: "claude-opus-5-5", to: "claude-opus-4-8" });
    expect(screen.getByTestId("assistant-cloud-note")).toHaveTextContent(
      "claude-opus-5-5 declined; claude-opus-4-8 is answering…",
    );
    await emit(started, {
      kind: "done",
      result: result({ servedBy: "claude-opus-4-8", fallbackFrom: "claude-opus-5-5" }),
    });

    expect(await screen.findByTestId("assistant-cloud-fallback")).toHaveTextContent(
      "claude-opus-5-5 declined, so claude-opus-4-8 answered",
    );
    expect(screen.getByTestId("assistant-cloud-meta")).toHaveTextContent(
      "Answered by claude-opus-4-8",
    );
  });

  it("says why the service declined, keeps no partial answer, and does not send the question again", async () => {
    seedDb();
    const started = rust();
    render(<LocalAssistantChat />);
    await ask(started, "Yasak soru");

    await emit(started, BOUND);
    await emit(started, { kind: "token", text: "Yarım" });
    await emit(started, {
      kind: "done",
      result: result({ text: "Yarım", stop: "refusal", refusalCategory: "cyber" }),
    });

    expect(await screen.findByTestId("assistant-cloud-refusal")).toHaveTextContent(
      "The service declined to answer (cybersecurity).",
    );
    expect(screen.queryByText("Yarım")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(lastSaved()).toMatchObject({
        role: "assistant",
        content: "",
        cloud: { stop: "refusal", refusalCategory: "cyber" },
      }),
    );
    expect(lastSaved()?.blocks).toBeUndefined();

    await ask(started, "Başka soru");
    expect(started[1]!.messages).toEqual([{ role: "user", content: "Başka soru" }]);
  });

  it("offers to continue an answer cut off at its length limit", async () => {
    seedDb();
    const started = rust();
    render(<LocalAssistantChat />);
    await ask(started, "Uzun anlat");
    await emit(started, BOUND);
    await emit(started, { kind: "done", result: result({ text: "Uzun yanıt", stop: "max_tokens", blocks: [{ type: "text", text: "Uzun yanıt" }] }) });

    const notice = await screen.findByTestId("assistant-cloud-cut-off");
    expect(notice).toHaveTextContent("The answer reached its length limit and was cut off.");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(started).toHaveLength(2));
    // The question went out before: it goes again exactly as it did.
    expect(started[1]!.messages).toEqual([
      { role: "user", content: "Uzun anlat", sent: true },
      { role: "assistant", content: "Uzun yanıt", blocks: [{ type: "text", text: "Uzun yanıt" }] },
      { role: "user", content: "Please continue where you stopped." },
    ]);
  });

  it("says an answer cut off before any text was cut off, and can continue it", async () => {
    seedDb();
    const started = rust();
    render(<LocalAssistantChat />);
    await ask(started, "Uzun anlat");
    await emit(started, BOUND);
    await emit(started, {
      kind: "done",
      result: result({
        text: "",
        stop: "max_tokens",
        blocks: [{ type: "thinking", thinking: "uzun plan", signature: "sig" }],
      }),
    });

    expect(await screen.findByTestId("assistant-cloud-cut-off")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-cloud-meta")).toHaveTextContent("≈ $0.0054");
    await waitFor(() =>
      expect(lastSaved()).toMatchObject({ role: "assistant", content: "", cloud: { stop: "max_tokens" } }),
    );
    expect(lastSaved()?.blocks).toBeUndefined();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(started).toHaveLength(2));
    expect(started[1]!.messages).toEqual([
      { role: "user", content: "Uzun anlat", sent: true },
      { role: "user", content: "Please continue where you stopped." },
    ]);
  });

  it("says so when an answer arrives with nothing in it", async () => {
    seedDb();
    const started = rust();
    render(<LocalAssistantChat />);
    await ask(started, "Soru");
    await emit(started, BOUND);
    await emit(started, { kind: "done", result: result({ text: "", blocks: [] }) });

    expect(await screen.findByRole("alert")).toHaveTextContent("The service's answer could not be read.");
  });

  it("keeps the starter prompts generic, naming no investigation", async () => {
    seedDb();
    createEngagement("Acme web audit");
    rust();
    render(<LocalAssistantChat />);

    expect(await screen.findByText("How do I read a Gitleaks report?")).toBeInTheDocument();
    expect(screen.queryByText(/Acme web audit/)).not.toBeInTheDocument();
  });

  it("keeps what streamed when the answer is stopped, without an error", async () => {
    seedDb();
    const started = rust();
    render(<LocalAssistantChat />);
    await ask(started, "Soru");
    await emit(started, BOUND);
    await emit(started, { kind: "token", text: "Başlangıç" });

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(invoke).toHaveBeenCalledWith("ai_chat_cancel", { requestId: started[0]!.requestId });
    await emit(started, { kind: "error", error: { code: "cancelled" } });

    expect(await screen.findByText("Başlangıç")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(lastSaved()).toMatchObject({ role: "assistant", content: "Başlangıç" }));
  });

  it("says in plain words why a turn failed", async () => {
    seedDb();
    const started = rust();
    render(<LocalAssistantChat />);
    await ask(started, "Soru");

    await emit(started, { kind: "error", error: { code: "rate_limited", retryAfterSeconds: 12 } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. Try again in 12 seconds.");
  });

  it("with no key, says so and leads to Settings, and sends nothing", async () => {
    seedDb();
    const started = rust({ present: false, last4: null, baseUrl: null });
    render(<LocalAssistantChat />);

    const notice = await screen.findByTestId("assistant-cloud-setup");
    expect(notice).toHaveTextContent("There is no key for Claude (Anthropic) yet.");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Message to Jarvis"), "Selam{Enter}");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(started).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(useUi.getState().settingsSection).toBe("ai");
  });
});
