import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

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
import { createConversation } from "@/lib/db/conversations";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import { grantCloudConsent } from "@/lib/cloudConsent";
import { createEngagement } from "@/services/appService";
import { useUi } from "@/state/ui";
import { LocalAssistantChat } from "./LocalAssistantChat";

/* The first cloud question about an
   investigation asks before the investigation's summary goes. Rust is
   mocked at `invoke`; no key is read and nothing leaves the test. */

Element.prototype.scrollTo = vi.fn();

type Started = { requestId: string; target: unknown; model: string; messages: { role: string; content: string; sent?: boolean }[] };
const KEY = { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" };
/** The key Rust holds; a test re-saves it for another address. */
let key = KEY;
/** When set, listing the investigation's files waits on it. */
let filesGate: Promise<void> | null = null;

function rust() {
  const started: Started[] = [];
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "ai_key_has":
        return key;
      case "ai_mask_preview":
        return { text: String(args.text), masked: 0 };
      case "investigation_files_list":
        if (filesGate) await filesGate;
        return [];
      case "analysis_list":
        return [];
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

const done = {
  text: "Tamam",
  blocks: [{ type: "text", text: "Tamam" }],
  stop: "end_turn",
  refusalCategory: null,
  servedBy: "claude-opus-5-5",
  fallbackFrom: null,
  usage: null,
};

let engagementId = "";

beforeEach(async () => {
  invoke.mockReset();
  handlers.length = 0;
  key = KEY;
  filesGate = null;
  useUi.setState({ settingsSection: null });
  setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ aiProvider: "anthropic", localAssistantEnabled: false });
  setDbForTesting(db);
  engagementId = createEngagement("Home Lab");
  db.collection("targets").put({
    id: "t-1",
    engagementId,
    raw: "192.168.56.10",
    normalized: "192.168.56.10",
    kind: "ip",
    scopeState: "in_scope",
    notes: "",
    demo: false,
    createdAt: 1,
    updatedAt: 1,
  });
});

afterEach(() => {
  resetBridgeForTesting();
  setDbForTesting(null);
  vi.clearAllMocks();
});

const composer = () => screen.getByLabelText("Message to Jarvis");

async function type(text: string) {
  const user = userEvent.setup();
  await user.type(composer(), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

const engagement = () => getDb().collection("engagements").get(engagementId)!;
const chat = () => render(<MemoryRouter><LocalAssistantChat /></MemoryRouter>);

// The whole suite runs these in parallel with the rest; the longest of them
// took more than 5 s under that load and under 1 s on its own.
vi.setConfig({ testTimeout: 20_000 });

describe("asking Jarvis about an investigation", () => {
  it(
    "shows the question and the summary before they go, then sends the summary once",
    async () => {
      await createConversation(getDb(), { engagementId });
      const started = rust();
      chat();

      await type("What next?");
      const card = await screen.findByTestId("assistant-consent-card");
      expect(card).toHaveTextContent("The summary of “Home Lab” goes with this question");
      expect(card).toHaveTextContent("Claude (Anthropic) (api.anthropic.com)");
      expect(card).toHaveTextContent("Your question: What next?");
      expect(card).toHaveTextContent("Targets (1): 192.168.56.10");
      // The decision takes the focus, and the starters make way for it.
      expect(screen.getByRole("heading", { name: /goes with this question/ })).toHaveFocus();
      expect(screen.getByRole("status")).toHaveTextContent("the summary of “Home Lab” would go");
      expect(started).toHaveLength(0);

      await userEvent.click(screen.getByRole("button", { name: "Allow and send" }));
      await waitFor(() => expect(started).toHaveLength(1));
      const first = started[0]!.messages[0]!;
      expect(first.content).toMatch(/^Qutra Labs investigation summary\./);
      expect(first.content).toMatch(/\n\nWhat next\?$/);
      expect(engagement().cloudConsent).toMatchObject({
        provider: "anthropic",
        host: "api.anthropic.com",
      });
      expect(composer()).toHaveFocus();
      expect(composer()).toHaveValue("");
      // Nothing says it went before Rust says so.
      expect(screen.queryByTestId("assistant-context-sent")).toBeNull();

      const sentText = first.content.replace("Home Lab", "Home Lab [masked]");
      await emit(started, {
        kind: "bound",
        endpoint: "api.anthropic.com",
        model: "claude-opus-5-5",
        sentBytes: 900,
        masked: 1,
        sentText,
      });
      expect(screen.getByTestId("assistant-context-sent")).toHaveTextContent(
        "Sent with the investigation summary",
      );
      expect(screen.getByTestId("assistant-context-sent")).toHaveTextContent("Home Lab [masked]");
      await emit(started, { kind: "done", result: done });
      await screen.findByText("Tamam");
      await type("And then?");
      await waitFor(() => expect(started).toHaveLength(2));
      // The summary went once, with the first question, and goes again as part
      // of it, as it went; the new question carries none.
      expect(started[1]!.messages[0]).toEqual({ role: "user", content: sentText, sent: true });
      expect(started[1]!.messages.at(-1)).toEqual({ role: "user", content: "And then?" });
    },
    15_000,
  );

  it("sends nothing on Cancel, and nothing asks again once the investigation allows it", async () => {
    await createConversation(getDb(), { engagementId });
    const started = rust();
    const { unmount } = chat();

    await type("What next?");
    await screen.findByTestId("assistant-consent-card");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("assistant-consent-card")).toBeNull();
    expect(composer()).toHaveFocus();
    expect(started).toHaveLength(0);
    expect(engagement()).not.toHaveProperty("cloudConsent");
    unmount();

    await grantCloudConsent(engagementId, { provider: "anthropic", host: "api.anthropic.com" });
    await createConversation(getDb(), { engagementId, now: Date.now() + 1000 });
    chat();
    await type("Second question");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(screen.queryByTestId("assistant-consent-card")).toBeNull();
    expect(started[0]!.messages[0]!.content).toMatch(/Targets \(1\): 192\.168\.56\.10[\s\S]*\n\nSecond question$/);
  });

  it("asks again when the chosen connection is not the one allowed", async () => {
    await grantCloudConsent(engagementId, { provider: "anthropic", host: "proxy.example" });
    await createConversation(getDb(), { engagementId });
    const started = rust();
    chat();

    await type("What next?");
    expect(await screen.findByTestId("assistant-consent-card")).toBeInTheDocument();
    expect(started).toHaveLength(0);
  });

  it("does not let a card allow another address the key was saved for meanwhile", async () => {
    await createConversation(getDb(), { engagementId });
    const started = rust();
    chat();

    await type("What next?");
    await screen.findByTestId("assistant-consent-card");
    key = { ...KEY, baseUrl: "https://proxy.example" };
    await userEvent.click(screen.getByRole("button", { name: "Allow and send" }));

    // The card the user allowed named api.anthropic.com: a new one names the
    // address the question would now go to, and nothing went.
    await waitFor(() =>
      expect(screen.getByTestId("assistant-consent-card")).toHaveTextContent("(proxy.example)"),
    );
    expect(started).toHaveLength(0);
    expect(engagement()).not.toHaveProperty("cloudConsent");
  });

  it("drops the card when another connection is chosen", async () => {
    await createConversation(getDb(), { engagementId });
    const started = rust();
    chat();

    await type("What next?");
    await screen.findByTestId("assistant-consent-card");
    act(() => {
      getDb().prefs.set({ aiProvider: "openai_compat", aiOpenAiPreset: "groq" });
    });
    await waitFor(() => expect(screen.queryByTestId("assistant-consent-card")).toBeNull());
    expect(started).toHaveLength(0);
    expect(engagement()).not.toHaveProperty("cloudConsent");
  });

  it("drops a question whose conversation changed while it was prepared", async () => {
    await createConversation(getDb(), { engagementId });
    const started = rust();
    let release = () => {};
    filesGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    chat();

    await type("What next?");
    expect(await screen.findByTestId("assistant-consent-preparing")).toBeInTheDocument();
    // A second Enter meanwhile is not a second question.
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const other = await act(() => createConversation(getDb(), { now: Date.now() + 1000 }));
    await act(async () => {
      release();
    });

    await waitFor(() => expect(screen.queryByTestId("assistant-consent-preparing")).toBeNull());
    expect(screen.queryByTestId("assistant-consent-card")).toBeNull();
    expect(invoke.mock.calls.filter(([command]) => command === "investigation_files_list")).toHaveLength(1);
    expect(getDb().collection("conversations").get(other.id)!.messages).toEqual([]);
    // The question is not lost: it waits in the composer.
    expect(composer()).toHaveValue("What next?");

    // The other conversation is not about the investigation: its question
    // goes as it is.
    await userEvent.clear(composer());
    await type("Hello");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("carries the summary again after the question that carried it was declined", async () => {
    await grantCloudConsent(engagementId, { provider: "anthropic", host: "api.anthropic.com" });
    await createConversation(getDb(), { engagementId });
    const started = rust();
    chat();

    await type("What next?");
    await waitFor(() => expect(started).toHaveLength(1));
    const first = started[0]!.messages[0]!;
    await emit(started, { kind: "bound", endpoint: "api.anthropic.com", model: "claude-opus-5-5", sentBytes: 900, masked: 0, sentText: first.content });
    await emit(started, { kind: "done", result: { ...done, text: "", blocks: [], stop: "refusal", refusalCategory: "cyber" } });
    await screen.findByTestId("assistant-cloud-refusal");

    await type("Put another way?");
    await waitFor(() => expect(started).toHaveLength(2));
    // The declined question is left out with its summary; the next carries it.
    expect(started[1]!.messages).toHaveLength(1);
    expect(started[1]!.messages[0]!.content).toMatch(/^Qutra Labs investigation summary\.[\s\S]*\n\nPut another way\?$/);
  });

  it("prepares nothing for a connection whose address cannot be read", async () => {
    await createConversation(getDb(), { engagementId });
    const started = rust();
    key = { present: true, last4: "WXYZ", baseUrl: null as unknown as string };
    chat();

    await type("What next?");
    expect(await screen.findByText("The investigation summary could not be prepared. Try again.")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-consent-card")).toBeNull();
    expect(started).toHaveLength(0);
    expect(engagement()).not.toHaveProperty("cloudConsent");
  });

  it("hides the card once it is allowed, so a Cancel cannot follow an Allow", async () => {
    await createConversation(getDb(), { engagementId });
    const started = rust();
    chat();

    await type("What next?");
    await screen.findByTestId("assistant-consent-card");
    let release = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "ai_key_has") await slow;
      return previous(command, args);
    });
    await userEvent.click(screen.getByRole("button", { name: "Allow and send" }));
    // While the allowance is being kept, the card and its Cancel are gone.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(started).toHaveLength(1));
    expect(engagement().cloudConsent).toMatchObject({ host: "api.anthropic.com" });
  });

  it("keeps what is typed while a question is being prepared", async () => {
    await grantCloudConsent(engagementId, { provider: "anthropic", host: "api.anthropic.com" });
    await createConversation(getDb(), { engagementId });
    const started = rust();
    let release = () => {};
    filesGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    chat();

    await type("q1");
    await screen.findByTestId("assistant-consent-preparing");
    await userEvent.type(composer(), " and port 445");
    await act(async () => {
      release();
    });
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.messages.at(-1)!.content).toMatch(/\n\nq1$/);
    expect(composer()).toHaveValue("q1 and port 445");
  });

  it("says when allowing replaces the allowance for another connection", async () => {
    await grantCloudConsent(engagementId, { provider: "openai", host: "api.openai.com" });
    await createConversation(getDb(), { engagementId });
    rust();
    chat();

    await type("What next?");
    expect(await screen.findByTestId("assistant-consent-card")).toHaveTextContent(
      "This replaces the investigation's allowance for api.openai.com",
    );
  });

  it("does not go on in the cloud after a revoke, and offers a new conversation", async () => {
    const conversation = await createConversation(getDb(), { engagementId });
    await getDb()
      .collection("conversations")
      .updateDurable(conversation.id, (existing) => ({
        ...existing,
        messages: [
          { id: "m1", role: "user", content: "What next?", context: "summary", cloudSent: true, createdAt: 1, requestId: "r1" },
          { id: "m2", role: "assistant", content: "Tamam", createdAt: 2, requestId: "r1" },
        ],
      }));
    const started = rust();
    chat();

    await type("More");
    expect(await screen.findByText(/does not allow this connection/)).toBeInTheDocument();
    expect(started).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await waitFor(() =>
      expect(
        getDb()
          .collection("conversations")
          .getAll()
          .filter((c) => c.engagementId === engagementId),
      ).toHaveLength(2),
    );
  });
});
