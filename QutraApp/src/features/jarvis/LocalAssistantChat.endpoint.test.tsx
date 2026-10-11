import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import type { NewMessage } from "@/lib/db/conversations";
import {
  AssistantBlockedError,
  localAssistant,
} from "@/lib/localAssistant/client";
import { type EngineModel, type EngineReport, localEngine } from "@/lib/localEngine/client";
import { LocalAssistantChat } from "./LocalAssistantChat";

/* Two behaviours at the chat surface, on Qutra's own local engine
   (ADR 0016):

   - Recipient: the engine starts on a free port each time, so the address
     the last check saw need not be where a turn goes. The turn must say where
     the conversation actually went, and a change of recipient between answers
     must be visible, not inferred.
   - Readiness: once the assistant is enabled, the chat keeps the readiness
     panel, with the engine's next step and the retry. */

vi.mock("@/lib/localEngine/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/localEngine/client")>();
  return {
    ...actual,
    localEngine: {
      available: vi.fn().mockReturnValue(true),
      status: vi.fn(),
      models: vi.fn(),
      listen: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      install: vi.fn(),
      prepare: vi.fn(),
      cancelTask: vi.fn(),
      deleteCopy: vi.fn(),
      openModelsFolder: vi.fn(),
      setIdleMinutes: vi.fn(),
    },
  };
});

vi.mock("@/lib/localAssistant/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/localAssistant/client")>();
  return {
    ...actual,
    localAssistant: {
      available: vi.fn().mockReturnValue(true),
      checkHealth: vi.fn().mockResolvedValue({ status: "ready", models: ["qwen2.5:14b"] }),
      listModels: vi.fn().mockResolvedValue({ status: "unavailable", models: [] }),
      streamChat: vi.fn(),
      approveTool: vi.fn().mockResolvedValue({ resolved: true }),
    },
  };
});

const streamChat = vi.mocked(localAssistant.streamChat);
const checkHealth = vi.mocked(localAssistant.checkHealth);

Element.prototype.scrollTo = vi.fn();

type Binding = { endpoint: string; model: string };
type StreamOptions = { onBound?: (binding: Binding) => void; onToken?: (text: string) => void };

function armStreamChat() {
  let options!: StreamOptions;
  let settle!: (value: string) => void;
  streamChat.mockImplementationOnce((_config, _messages, opts) => {
    options = (opts ?? {}) as StreamOptions;
    return new Promise<string>((resolve) => {
      settle = resolve;
    });
  });
  return { getOptions: () => options, settle: (value: string) => settle(value) };
}

const NOW = "http://127.0.0.1:50123";
const BEFORE = "http://127.0.0.1:50177";
const READY = {
  status: "ready" as const,
  models: ["qwen2.5:14b"],
  endpoint: NOW,
  selectedModel: "qwen2.5:14b",
};

function seedDb(prefs: Record<string, unknown> = {}) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ localAssistantEnabled: true, assistantContextEnabled: false, ...prefs });
  setDbForTesting(db);
  return db;
}

function seedConversation(db: Database, messages: NewMessage[]) {
  db.collection("conversations").put({
    id: "conv_mbx1q2r3a1b2c3d4",
    title: "",
    workspaceId: null,
    engagementId: null,
    origin: "chat",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    eraseRevision: 0,
    messages: messages.map((m, i) => ({
      ...m,
      id: `msg_mbx1q2r3${i}`,
      createdAt: 1,
      requestId: "8d0c2f8e-3c55-4b55-9f43-2a6f0e7c1b9a",
    })),
  });
}

async function ask(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Message to Jarvis"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(streamChat).toHaveBeenCalled());
}

// The engine strip and its activity line listen for the engine's events.
beforeEach(() => {
  vi.mocked(localEngine.available).mockReturnValue(true);
  vi.mocked(localEngine.listen).mockResolvedValue(() => {});
});

afterEach(() => {
  setDbForTesting(null);
  vi.clearAllMocks();
  // clearAllMocks keeps queued Once values. A test that fails before its
  // probe or turn consumes one must not hand it to the next test.
  checkHealth.mockReset();
  checkHealth.mockResolvedValue({ status: "ready", models: ["qwen2.5:14b"] });
  streamChat.mockReset();
});

describe("each answer names where the conversation was sent",() => {
  it("shows the recipient as soon as the turn binds, before the answer arrives", async () => {
    seedDb();
    const stream = armStreamChat();
    render(<LocalAssistantChat />);
    await ask("hi");

    act(() => stream.getOptions().onBound?.({ endpoint: NOW, model: "qwen2.5:14b" }));

    expect(screen.getByTestId("assistant-turn-recipient")).toHaveTextContent(
      `Sent to qwen2.5:14b at ${NOW}`,
    );
  });

  it("keeps the recipient with the answer, in the transcript and in storage", async () => {
    seedDb();
    const stream = armStreamChat();
    render(<LocalAssistantChat />);
    await ask("hi");

    act(() => stream.getOptions().onBound?.({ endpoint: NOW, model: "qwen2.5:14b" }));
    await act(async () => stream.settle("Hello there"));

    await screen.findByText("Hello there");
    expect(screen.getByTestId("assistant-turn-recipient")).toHaveTextContent(
      `Sent to qwen2.5:14b at ${NOW}`,
    );
    await waitFor(() =>
      expect(
        getDb().collection("conversations").getAll()[0]?.messages.at(-1),
      ).toMatchObject({
        role: "assistant",
        content: "Hello there",
        answeredBy: { endpoint: NOW, model: "qwen2.5:14b" },
      }),
    );
  });

  it("marks an answer that went to a different address than the answer before it", async () => {
    seedConversation(seedDb(), [
      { role: "user", content: "earlier" },
      {
        role: "assistant",
        content: "earlier answer",
        answeredBy: { endpoint: BEFORE, model: "qwen2.5:14b" },
      },
    ]);
    const stream = armStreamChat();
    render(<LocalAssistantChat />);
    // The stored answer's recipient survives a reload.
    expect(screen.getByTestId("assistant-turn-recipient")).toHaveTextContent(BEFORE);
    expect(screen.queryByTestId("assistant-turn-recipient-changed")).toBeNull();

    await ask("again");
    act(() => stream.getOptions().onBound?.({ endpoint: NOW, model: "qwen2.5:14b" }));
    await act(async () => stream.settle("new answer"));

    await screen.findByText("new answer");
    const changed = screen.getByTestId("assistant-turn-recipient-changed");
    expect(changed).toHaveTextContent(/different address/i);
    expect(changed).toHaveTextContent(BEFORE);
  });
});

describe("the enabled Assistant view keeps its readiness panel until ready",() => {
  const engine = vi.mocked(localEngine);
  const qwen = {
    id: "qwen2.5:14b",
    name: "qwen2.5:14b",
    source: "ollama",
    sizeBytes: 8_988_110_976,
    architecture: "qwen2",
    tools: true,
    prepared: false,
    state: "ready",
  } as EngineModel;

  /** What Rust found: whether the engine is installed, and the models. */
  function engineFinds(installed: boolean, models: EngineModel[] = [qwen]) {
    const report: EngineReport = {
      status: { phase: "stopped", model: null, endpoint: null, error: null, idleMinutes: 5, build: "b11541" },
      installed,
      build: "b11541",
      commit: "f2918cabb",
      downloadSource: "github.com/ggml-org/llama.cpp",
      downloadBytes: 33_464_528,
      task: null,
    };
    engine.status.mockResolvedValue(report);
    engine.models.mockResolvedValue({ models, ollamaStore: true, freeBytes: 90 * 1024 ** 3 });
  }

  const ENGINE_MISSING = {
    status: "engine_missing" as const,
    models: ["qwen2.5:14b"],
    selectedModel: "qwen2.5:14b",
  };

  beforeEach(() => engineFinds(true));

  it("shows the engine's one-time download when the engine is not installed", async () => {
    seedDb();
    engineFinds(false);
    checkHealth.mockResolvedValueOnce(ENGINE_MISSING);
    render(<LocalAssistantChat />);

    const readiness = await screen.findByTestId("assistant-readiness");
    expect(await within(readiness).findByTestId("local-engine-install")).toBeInTheDocument();
    expect(within(readiness).getByTestId("local-assistant-status")).toHaveTextContent(
      "Local engine not installed",
    );
    expect(readiness.textContent).not.toMatch(/ollama (serve|pull)/i);
    expect(screen.getByTestId("local-assistant-chat")).toBeInTheDocument();
  });

  it("keeps the panel until a check finds the engine ready, then gets out of the way", async () => {
    seedDb();
    engineFinds(false);
    checkHealth.mockResolvedValueOnce(ENGINE_MISSING).mockResolvedValueOnce(READY);
    const user = userEvent.setup();
    render(<LocalAssistantChat />);
    await screen.findByTestId("local-engine-install");

    await user.click(screen.getByTestId("local-assistant-test-connection"));

    await waitFor(() => expect(screen.queryByTestId("assistant-readiness")).toBeNull());
    expect(checkHealth).toHaveBeenCalledTimes(2);
  });

  /* Ready when the view opened is not ready forever. A turn that fails
     because the engine or its model cannot serve it must bring the next step
     back, on both paths such a failure takes: a terminal error event during
     the turn, and a refusal before it starts. */

  it("brings the panel back when a turn finds the engine missing", async () => {
    seedDb();
    checkHealth.mockResolvedValueOnce(READY);
    streamChat.mockImplementationOnce(async (_config, _messages, opts) => {
      opts?.onError?.(new AssistantBlockedError("engine_missing"));
      return "";
    });
    render(<LocalAssistantChat />);
    await waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(1));
    engineFinds(false);
    checkHealth.mockResolvedValueOnce(ENGINE_MISSING);

    await ask("hi");

    expect(await screen.findByTestId("local-engine-install")).toBeInTheDocument();
    expect(screen.getByText(/The local engine isn't installed yet/)).toBeInTheDocument();
    expect(checkHealth).toHaveBeenCalledTimes(2);
  });

  it("brings the panel back when a turn finds the model needs its one-time copy", async () => {
    seedDb({ ollamaModel: "gemma4:26b" });
    const gemma = {
      ...qwen,
      id: "gemma4:26b",
      name: "gemma4:26b",
      architecture: "gemma4",
      tools: null,
      state: "needs_prepare",
      writeBytes: 16_778_706_880,
    } as EngineModel;
    engineFinds(true, [gemma]);
    checkHealth.mockResolvedValueOnce({ ...READY, models: ["gemma4:26b"], selectedModel: "gemma4:26b" });
    streamChat.mockRejectedValueOnce(new AssistantBlockedError("model_needs_prepare"));
    render(<LocalAssistantChat />);
    await waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(1));
    checkHealth.mockResolvedValueOnce({
      status: "needs_prepare",
      models: ["gemma4:26b"],
      selectedModel: "gemma4:26b",
    });

    await ask("hi");

    expect(await screen.findByTestId("local-engine-prepare")).toBeInTheDocument();
    expect(screen.getByText(/needs a one-time copy before Jarvis can run it/)).toBeInTheDocument();
    expect(checkHealth).toHaveBeenCalledTimes(2);
  });
});
