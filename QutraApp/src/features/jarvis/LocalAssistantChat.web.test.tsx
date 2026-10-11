import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import { createConversation, openConversation } from "@/lib/db/conversations";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import { AssistantBlockedError, localAssistant } from "@/lib/localAssistant/client";
import { useUi } from "@/state/ui";
import { LocalAssistantChat } from "./LocalAssistantChat";

/* The "İnternet" switch at the chat: off by default, kept per conversation,
   sent to Rust only when on, and the pages an answer drew on listed under it.
   Rust is mocked at `invoke` and the local client; nothing leaves the test. */

Element.prototype.scrollTo = vi.fn();

const streamChat = vi.mocked(localAssistant.streamChat);
const openUrl = vi.fn().mockResolvedValue({ ok: true, simulated: false });

type Started = {
  requestId: string;
  target: unknown;
  model: string;
  messages: unknown[];
  webAccess?: boolean;
};

function rust() {
  const started: Started[] = [];
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "ai_key_has":
        return { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" };
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

async function emit(started: Started[], payload: Record<string, unknown>) {
  const requestId = started.at(-1)!.requestId;
  await act(async () => {
    for (const handler of [...handlers]) handler({ payload: { requestId, ...payload } });
  });
}

const SOURCES = [
  { url: "https://docs.example.org/rust/news", title: "What is new in Rust" },
  { url: "https://blog.example.com/post?id=7", title: "A post" },
];

const result = (overrides: Record<string, unknown> = {}) => ({
  text: "Rust 2027 is out.",
  blocks: [{ type: "text", text: "Rust 2027 is out." }],
  stop: "end_turn",
  refusalCategory: null,
  servedBy: "claude-opus-5-5",
  fallbackFrom: null,
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
  ...overrides,
});

function seedDb(prefs: Record<string, unknown> = {}) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({
    aiProvider: "anthropic",
    localAssistantEnabled: false,
    assistantContextEnabled: false,
    ...prefs,
  });
  setDbForTesting(db);
  return db;
}

const toggle = () => screen.getByTestId("assistant-web-toggle");
const conversation = () => getDb().collection("conversations").getAll()[0];

async function ask(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Message to Jarvis"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

beforeEach(() => {
  invoke.mockReset();
  handlers.length = 0;
  openUrl.mockClear();
  useUi.setState({ settingsSection: null });
  setBridgeForTesting({ mode: "tauri", openUrl } as unknown as DesktopBridge);
});

afterEach(() => {
  resetBridgeForTesting();
  setDbForTesting(null);
  vi.clearAllMocks();
});

describe("the internet switch", () => {
  it("is off by default, and a question then carries no web request", async () => {
    seedDb();
    const started = rust();
    render(<LocalAssistantChat />);
    expect(await screen.findByTestId("assistant-web-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("assistant-web-chip")).not.toBeInTheDocument();

    await ask("Selam");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).not.toHaveProperty("webAccess");
  });

  it("turns on with a globe chip, is kept on the conversation, and is sent with the question", async () => {
    seedDb();
    const started = rust();
    render(<LocalAssistantChat />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("assistant-web-toggle"));

    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("assistant-web-chip")).toHaveTextContent(
      "Internet on · Claude (Anthropic) does the searching",
    );
    await waitFor(() => expect(conversation()?.webAccess).toBe(true));

    await ask("What is new in Rust?");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ webAccess: true, target: { provider: "anthropic" } });

    // Off again: the field goes, and the next question carries nothing.
    await emit(started, { kind: "done", result: result() });
    await screen.findByText("Rust 2027 is out.");
    await user.click(toggle());
    await waitFor(() => expect(conversation()?.webAccess).toBeUndefined());
    expect(screen.queryByTestId("assistant-web-chip")).not.toBeInTheDocument();
    await ask("And now?");
    await waitFor(() => expect(started).toHaveLength(2));
    expect(started[1]).not.toHaveProperty("webAccess");
  });

  it("is remembered per conversation: another conversation starts off", async () => {
    const db = seedDb();
    rust();
    const first = await createConversation(db, { webAccess: true, now: 5 });
    render(<LocalAssistantChat />);
    expect(await screen.findByTestId("assistant-web-toggle")).toHaveAttribute("aria-pressed", "true");

    const second = await createConversation(db, { now: 9 });
    await act(async () => openConversation(db, second.id, 10));
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-pressed", "false"));
    expect(db.collection("conversations").get(first.id)?.webAccess).toBe(true);

    await act(async () => openConversation(db, first.id, 11));
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-pressed", "true"));
  });

  it("is not offered for another service, and nothing is sent for it", async () => {
    const db = seedDb();
    const started = rust();
    await createConversation(db, {
      webAccess: true,
      model: { provider: "openai_compat", preset: "openai", model: "gpt-x" },
    });
    render(<LocalAssistantChat />);
    expect(await screen.findByTestId("assistant-web-toggle")).toBeDisabled();
    expect(screen.queryByTestId("assistant-web-chip")).not.toBeInTheDocument();

    await ask("Selam");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).not.toHaveProperty("webAccess");
  });
});

describe("the pages an answer drew on", () => {
  it("lists a Claude answer's sources as links that open through the checked opener, and keeps them", async () => {
    const db = seedDb();
    const started = rust();
    await createConversation(db, { webAccess: true });
    render(<LocalAssistantChat />);
    await ask("What is new in Rust?");
    await waitFor(() => expect(started).toHaveLength(1));

    await emit(started, { kind: "searching" });
    expect(screen.getByTestId("assistant-cloud-note")).toHaveTextContent("Searching the internet…");
    await emit(started, { kind: "token", text: "Rust 2027 is out." });
    await emit(started, { kind: "done", result: result({ sources: SOURCES }) });

    const list = await screen.findByTestId("assistant-web-sources");
    const links = within(list).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent("What is new in Rust");
    expect(links[0]).toHaveTextContent("docs.example.org");
    expect(links[0]).toHaveAttribute("href", "https://docs.example.org/rust/news");

    await userEvent.setup().click(links[1]!);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://blog.example.com/post?id=7");

    await waitFor(() =>
      expect(conversation()?.messages.at(-1)?.sources).toEqual(SOURCES),
    );
  });

  it("shows a stored answer's sources again, and never a link that is not a web address", async () => {
    const db = seedDb();
    rust();
    await createConversation(db, { now: 1 });
    const id = conversation()!.id;
    await db.collection("conversations").updateDurable(id, (c) => ({
      ...c,
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "Answer",
          createdAt: 1,
          requestId: null,
          sources: [
            { url: "https://ok.example/a", title: "<b>Fine</b>" },
            { url: "javascript:alert(1)", title: "Not a page" },
          ],
        },
      ],
    }));
    render(<LocalAssistantChat />);
    const list = await screen.findByTestId("assistant-web-sources");
    // The title is the page's own words, shown as text.
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    expect(within(list).getByRole("link")).toHaveTextContent("<b>Fine</b>");
  });

  it("keeps a local answer's sources, and asks Rust for the internet only when on", async () => {
    const db = seedDb({ aiProvider: "local", localAssistantEnabled: true });
    await createConversation(db, { webAccess: true });
    streamChat.mockImplementationOnce(async (_config, _messages, opts) => {
      opts?.onStatus?.("web_searching");
      opts?.onWebSources?.(SOURCES);
      opts?.onToken?.("Rust 2027 is out.");
      return "Rust 2027 is out.";
    });
    render(<LocalAssistantChat />);
    // A local model with the internet on is not "local only".
    expect(await screen.findByTestId("assistant-web-chip")).toHaveTextContent(
      "Internet on · local model, searches via Brave Search",
    );
    expect(screen.queryByText("Local only · no cloud")).not.toBeInTheDocument();

    await ask("What is new in Rust?");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    expect(streamChat.mock.calls[0]![0]).toMatchObject({ webAccess: true });

    const list = await screen.findByTestId("assistant-web-sources");
    expect(within(list).getAllByRole("link")).toHaveLength(2);
    await waitFor(() => expect(conversation()?.messages.at(-1)?.sources).toEqual(SOURCES));
  });

  it("sends a local question without the internet when the switch is off", async () => {
    seedDb({ aiProvider: "local", localAssistantEnabled: true });
    streamChat.mockResolvedValueOnce("Merhaba");
    render(<LocalAssistantChat />);
    expect(await screen.findByText("Local only · no cloud")).toBeInTheDocument();
    await ask("Selam");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    expect(streamChat.mock.calls[0]![0]).toMatchObject({ webAccess: false });
  });

  it("says a local search needs a search key, in plain words", async () => {
    const db = seedDb({ aiProvider: "local", localAssistantEnabled: true });
    await createConversation(db, { webAccess: true });
    streamChat.mockImplementationOnce(async (_config, _messages, opts) => {
      opts?.onError?.(new AssistantBlockedError("web_search_key_missing"));
      return "";
    });
    render(<LocalAssistantChat />);
    await ask("What is new in Rust?");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Searching the internet with a local model needs a search key",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("web_search_key_missing");
  });
});
