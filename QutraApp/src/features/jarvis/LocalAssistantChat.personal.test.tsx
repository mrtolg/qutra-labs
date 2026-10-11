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
      streamChat: vi.fn().mockResolvedValue("Tamam."),
      approveTool: vi.fn().mockResolvedValue({ resolved: true }),
    },
  };
});

import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import { createConversation } from "@/lib/db/conversations";
import { addMemory } from "@/lib/db/jarvis";
import { localAssistant } from "@/lib/localAssistant/client";
import { en as enCatalog } from "@/lib/i18n/en";
import { deferredEn } from "@/lib/i18n/deferred/en";
import { useUi } from "@/state/ui";
import { LocalAssistantChat } from "./LocalAssistantChat";

// The words only lazy pages read load after the first paint (src/lib/i18n/deferred).
const en = { ...enCatalog, ...deferredEn };

/* Qutra's memory and instructions, and the model a conversation chose.
   Rust is mocked at `invoke`; nothing leaves the test. */

Element.prototype.scrollTo = vi.fn();

type Started = { requestId: string; model: string; messages: { role: string; content: string }[] };
const KEY = { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" };

function rust() {
  const started: Started[] = [];
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "ai_key_has") return KEY;
    if (command === "ai_chat_start") {
      started.push(args.request as Started);
      return { accepted: true };
    }
    if (command === "ai_chat_cancel") return undefined;
    throw new Error(`unexpected ${command}`);
  });
  return started;
}

async function finish(started: Started[], text = "Tamam.") {
  const turn = started.at(-1)!;
  const requestId = turn.requestId;
  // Rust sends back the last question as it went out (here nothing to mask).
  const sentText = turn.messages.at(-1)!.content;
  await act(async () => {
    for (const handler of [...handlers]) {
      handler({
        payload: { requestId, kind: "bound", endpoint: "api.anthropic.com", model: "claude-opus-5-5", sentBytes: 900, sentText },
      });
      handler({
        payload: {
          requestId,
          kind: "done",
          result: { text, blocks: null, stop: "end_turn", refusalCategory: null, servedBy: "claude-opus-5-5", fallbackFrom: null, usage: null },
        },
      });
    }
  });
}

async function ask(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Message to Qutra"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

function seed(prefs: Record<string, unknown>) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ assistantContextEnabled: false, ...prefs });
  setDbForTesting(db);
  return db;
}

beforeEach(() => {
  invoke.mockReset();
  handlers.length = 0;
  useUi.setState({ settingsSection: null });
  setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
});

afterEach(() => {
  setDbForTesting(null);
  resetBridgeForTesting();
  vi.clearAllMocks();
});

describe("Qutra's memory and instructions", () => {
  it("go to the cloud once, inside the first question, and say so under it", async () => {
    const db = seed({ aiProvider: "anthropic", localAssistantEnabled: false, jarvisAboutYou: "I test web apps." });
    await addMemory(db, "Lab network 10.10.0.0/24", 1);
    const started = rust();
    render(<LocalAssistantChat />);

    await ask("First question");
    await waitFor(() => expect(started).toHaveLength(1));
    const first = started[0]!.messages.at(-1)!.content;
    expect(first.startsWith(en["jarvis.personal.block.title"])).toBe(true);
    expect(first).toContain("I test web apps.");
    expect(first).toContain("- Lab network 10.10.0.0/24");
    expect(first.endsWith("First question")).toBe(true);
    await finish(started);
    expect(await screen.findByText(/Sent with your memory and instructions/)).toBeInTheDocument();

    await ask("Second question");
    await waitFor(() => expect(started).toHaveLength(2));
    const second = started[1]!.messages;
    // The history still holds the first question as it went; the new one
    // goes alone.
    expect(second.at(-1)!.content).toBe("Second question");
    expect(second.filter((m) => m.content.includes("I test web apps."))).toHaveLength(1);
  });

  it("send nothing extra when there is nothing to say", async () => {
    seed({ aiProvider: "anthropic", localAssistantEnabled: false });
    const started = rust();
    render(<LocalAssistantChat />);
    await ask("Plain");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.messages.at(-1)!.content).toBe("Plain");
  });

  it("ride as the system message of a local turn, to the model the conversation chose", async () => {
    const db = seed({
      aiProvider: "ollama",
      localAssistantEnabled: true,
      ollamaModel: "qwen2.5:14b",
      jarvisInstructions: "Commands first.",
    });
    await createConversation(db, { model: { provider: "local", model: "gemma4:26b" }, now: 1 });
    render(<LocalAssistantChat />);
    await ask("Merhaba");
    const streamChat = vi.mocked(localAssistant.streamChat);
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    const [config, messages] = streamChat.mock.calls[0]!;
    expect(config.ollamaModel).toBe("gemma4:26b");
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]!.content).toContain("Commands first.");
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "Merhaba" });
    // Nothing of it is kept with the question.
    await waitFor(() => expect(getDb().collection("conversations").getAll()[0]?.messages.length).toBe(2));
    expect(getDb().collection("conversations").getAll()[0]!.messages[0]!.personal).toBeUndefined();
  });

  it("a conversation set to Claude goes to Claude while the default stays local", async () => {
    const db = seed({ aiProvider: "ollama", localAssistantEnabled: true });
    await createConversation(db, { model: { provider: "anthropic", model: "claude-sonnet-5-5" }, now: 1 });
    const started = rust();
    render(<LocalAssistantChat />);
    await ask("Bulut");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.model).toBe("claude-sonnet-5-5");
    expect(vi.mocked(localAssistant.streamChat)).not.toHaveBeenCalled();
  });
});
