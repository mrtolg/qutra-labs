import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { clearAllConversations } from "@/lib/db/conversations";
import {
  AssistantBlockedError,
  type AssistantStreamEvent,
  localAssistant,
} from "@/lib/localAssistant/client";
import { LocalAssistantChat } from "./LocalAssistantChat";

/* A turn is unrecoverable once the Qutra page unmounts, so
   `LocalAssistantChat` has a cleanup effect calling `stop()`: navigating away
   mid-turn would otherwise leave the model generating with nobody reading,
   the abort ref gone with the component, and a pending approval card
   existing nowhere in the app for a human to answer. These
   tests drive the same hand-cranked `streamChat` mock the other
   `LocalAssistantChat.*.test.tsx` files use and assert on the *signal* the
   component was given, and on `approveTool`, rather than on broker
   internals this suite cannot see.

   Partial answers are covered here too, at the component level:
   a terminal tool-path error must not discard the prose that streamed
   before it, and the failure must still be visible and distinguishable from
   a normal, complete answer. `client.test.ts` covers the same contract at
   the client layer (settles with partial text, `onError` fires); this file
   covers that `LocalAssistantChat` actually persists that text and shows
   the error rather than silently dropping either half. */

vi.mock("@/lib/localAssistant/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/localAssistant/client")>();
  return {
    ...actual,
    localAssistant: {
      available: vi.fn().mockReturnValue(true),
      // The enabled chat probes readiness on mount.
      checkHealth: vi.fn().mockResolvedValue({ status: "ready", models: [] }),
      // The composer's model chip lists the local models once opened.
      // Stubbed as unreachable so these tests stay about their subject
      // and nothing here touches IPC.
      listModels: vi.fn().mockResolvedValue({ status: "unavailable", models: [] }),
      streamChat: vi.fn(),
      approveTool: vi.fn().mockResolvedValue({ resolved: true }),
    },
  };
});

/** The transcript: a conversation's first question is also its title. */
const transcript = () => within(screen.getByRole("log"));

const streamChat = vi.mocked(localAssistant.streamChat);
const approveTool = vi.mocked(localAssistant.approveTool);

Element.prototype.scrollTo = vi.fn();

type StreamOptions = {
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onToolCall?: (event: AssistantStreamEvent) => void;
  onToolResult?: (event: AssistantStreamEvent) => void;
  onError?: (error: AssistantBlockedError) => void;
};

/** Mirrors the real client's contract: settles (never rejects)
    on a terminal tool-path error, reporting it separately via `onError`. */
function armStreamChat() {
  let options!: StreamOptions;
  let settle!: (value: string) => void;
  streamChat.mockImplementationOnce((_config, _messages, opts) => {
    options = opts ?? {};
    return new Promise<string>((resolve) => {
      settle = resolve;
    });
  });
  return {
    getOptions: () => options,
    settle: (value = "") => settle(value),
  };
}

function seedDb() {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({
    localAssistantEnabled: true,
    assistantContextEnabled: false,
  });
  setDbForTesting(db);
  return db;
}

afterEach(() => {
  setDbForTesting(null);
  vi.clearAllMocks();
});

describe("LocalAssistantChat aborts an in-flight turn on unmount",() => {
  it("aborts the signal it gave streamChat when the component unmounts mid-turn", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    const { unmount } = render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Qutra"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    const signal = stream.getOptions().signal;
    expect(signal?.aborted).toBe(false);

    unmount();

    // Navigating away must reach the broker, not just stop listening --
    // otherwise the model keeps generating and the single-flight slot stays
    // held for up to TURN_TIMEOUT with nobody able to cancel it.
    expect(signal?.aborted).toBe(true);
  });

  it("explicitly rejects a pending approval on unmount instead of leaving the broker waiting on it", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    const { unmount } = render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Qutra"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    act(() => {
      stream.getOptions().onToolCall?.({
        requestId: "req-1",
        kind: "tool_call",
        callId: "call-1",
        summary: "Run in terminal: whoami",
      });
    });
    await screen.findByTestId("assistant-approval-card");

    unmount();

    // Nobody remains to answer this card -- reject it now rather than
    // leaving the broker's approval wait to expire on its own deadline.
    expect(approveTool).toHaveBeenCalledWith("req-1", "call-1", false);
  });

  it("does not re-answer an approval the user already decided before unmounting", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    const { unmount } = render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Qutra"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    act(() => {
      stream.getOptions().onToolCall?.({
        requestId: "req-1",
        kind: "tool_call",
        callId: "call-1",
        summary: "Run in terminal: whoami",
      });
    });
    await screen.findByTestId("assistant-approval-card");

    await user.click(screen.getByRole("button", { name: "Approve & run" }));
    expect(approveTool).toHaveBeenCalledTimes(1);
    expect(approveTool).toHaveBeenCalledWith("req-1", "call-1", true);

    unmount();

    // The card was already answered (Approve) -- unmount must not send a
    // second, contradictory decision for the same call.
    expect(approveTool).toHaveBeenCalledTimes(1);
  });

  it("does nothing extra on unmount once the turn already finished", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    const { unmount } = render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Qutra"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    const signal = stream.getOptions().signal;
    await act(async () => {
      stream.settle("done");
    });

    unmount();

    expect(signal?.aborted).toBe(false);
    expect(approveTool).not.toHaveBeenCalled();
  });
});

describe("revoking agent tool proposals stops the current agent turn", () => {
  it("aborts the in-flight turn when G goes from true to false", async () => {
    const db = seedDb();
    db.prefs.set({ assistantAgentToolsEnabled: true });
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Qutra"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    const signal = stream.getOptions().signal;
    expect(signal?.aborted).toBe(false);

    act(() => {
      db.prefs.set({ assistantAgentToolsEnabled: false });
    });

    expect(signal?.aborted).toBe(true);
  });
});

describe("a preserved partial answer stays distinguishable from a successful one",() => {
  it("keeps prose that streamed before a rejection, and still shows the error", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Qutra"), "please help");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    act(() => {
      stream.getOptions().onToken?.("Here is what I found before asking: ");
    });

    act(() => {
      stream.getOptions().onToolCall?.({
        requestId: "req-1",
        kind: "tool_call",
        callId: "call-1",
        summary: "Run in terminal: rm -rf /tmp/x",
      });
    });
    await screen.findByTestId("assistant-approval-card");

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(approveTool).toHaveBeenCalledWith("req-1", "call-1", false);

    await act(async () => {
      // Mirrors the real client: settles with the prose that
      // streamed before the rejection, and separately reports it via
      // onError, instead of rejecting the promise and losing it.
      stream.getOptions().onError?.(new AssistantBlockedError("approval_rejected"));
      stream.settle("Here is what I found before asking: ");
    });

    // The prose survives in the transcript...
    expect(
      screen.getByText("Here is what I found before asking:", { exact: false }),
    ).toBeInTheDocument();
    // ...and the failure is still visible, not silently swallowed by what
    // would otherwise look like a normal, complete answer.
    expect(await screen.findByRole("alert")).toHaveTextContent("Rejected");
  });

  it("shows no error banner at all when the turn simply completes", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Qutra"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    act(() => {
      stream.getOptions().onToken?.("A clean, complete answer.");
    });

    await act(async () => {
      stream.settle("A clean, complete answer.");
    });

    expect(
      screen.getByText("A clean, complete answer.", { exact: false }),
    ).toBeInTheDocument();
    // A genuinely successful turn must never be shown next to an error --
    // that would be the opposite mistake, making a real failure invisible.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/* The chat outlives the /jarvis route (ADR 0013), so Settings can erase the
   stored transcript while this component stays mounted. Before, the chat
   kept the erased messages on screen and the next turn persisted them
   straight back -- "clear history" did not stay cleared. */
describe("a transcript erased from Settings stays erased while the chat is kept alive", () => {
  it("drops the erased messages and does not write them back on the next turn", async () => {
    const db = seedDb();
    db.collection("conversations").put({
      id: "conv_mbx1q2r3a1b2c3d4",
      title: "old question",
      workspaceId: null,
      engagementId: null,
      origin: "chat",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
      eraseRevision: 0,
      messages: [
        { id: "msg_1", role: "user", content: "old question", createdAt: 1, requestId: "r-old" },
        { id: "msg_2", role: "assistant", content: "old answer", createdAt: 1, requestId: "r-old" },
      ],
    });
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);
    expect(await transcript().findByText("old question")).toBeInTheDocument();

    // What LocalAssistantSettings' "clear history" does.
    await act(async () => {
      await clearAllConversations(db);
    });
    await waitFor(() => expect(transcript().queryByText("old question")).toBeNull());

    await user.type(screen.getByLabelText("Message to Qutra"), "new question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => {
      stream.settle("new answer");
    });

    await waitFor(() => {
      const all = db.collection("conversations").getAll();
      expect(all).toHaveLength(1);
      expect(all[0]?.messages.map((m) => [m.role, m.content])).toEqual([
        ["user", "new question"],
        ["assistant", "new answer"],
      ]);
    });
  });
});
