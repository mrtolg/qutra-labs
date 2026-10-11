import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, setDbForTesting, getDb } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  AssistantBlockedError,
  AssistantTimeoutError,
  type AssistantStreamEvent,
  localAssistant,
} from "@/lib/localAssistant/client";
import { LocalAssistantChat } from "./LocalAssistantChat";

/* The inline approval card (ADR 0012, Decision 2). `localAssistant`
   is the module singleton the component imports directly, so it is mocked in
   place rather than injected -- the same shape `streamChat`/`approveTool`
   callers see in production, with the streaming lifecycle driven by hand from
   the test via the `options` the component passed in. */

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

// jsdom does not implement Element.scrollTo; the component calls it to keep
// the transcript pinned to the bottom as new content streams in. Stubbed
// here only -- this is a test-environment gap, not a behavior under test.
Element.prototype.scrollTo = vi.fn();

type StreamOptions = {
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onToolCall?: (event: AssistantStreamEvent) => void;
  onToolResult?: (event: AssistantStreamEvent) => void;
};

/** Captures the `options` object of the next `streamChat` call and gives the
    test a settle/fail pair to end the turn whenever it chooses, mirroring
    the real client's "resolves on `done`, rejects on `error`" contract. */
function armStreamChat() {
  let options!: StreamOptions;
  let settle!: (value: string) => void;
  let fail!: (error: unknown) => void;
  streamChat.mockImplementationOnce((_config, _messages, opts) => {
    options = opts ?? {};
    return new Promise<string>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
  });
  return {
    getOptions: () => options,
    settle: (value = "") => settle(value),
    fail: (error: unknown) => fail(error),
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

const MALICIOUS_SUMMARY =
  '<img src=x onerror="window.__pwned = true">Run in terminal: rm -rf /';

afterEach(() => {
  setDbForTesting(null);
  vi.clearAllMocks();
  delete (window as unknown as { __pwned?: boolean }).__pwned;
});

/** Press Clear conversation, then confirm it in the dialog that asks. */
async function clearConversation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Clear conversation" }));
  const dialog = await screen.findByRole("dialog", { name: "Clear this conversation?" });
  await user.click(within(dialog).getByRole("button", { name: "Clear conversation" }));
}

describe("LocalAssistantChat approval card", () => {
  it("renders a tool_call summary as plain text, never as markup, and disables sending while the card is pending", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    const input = screen.getByLabelText("Message to Jarvis");
    await user.type(input, "please help");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    act(() => {
      stream.getOptions().onToolCall?.({
        requestId: "req-1",
        kind: "tool_call",
        callId: "call-1",
        summary: MALICIOUS_SUMMARY,
      });
    });

    // The full summary text is on the page, verbatim...
    const card = await screen.findByTestId("assistant-approval-card");
    expect(card).toHaveTextContent(MALICIOUS_SUMMARY);

    // ...but it was never parsed as HTML: no <img> element exists inside the
    // card (scoped to the card, not `document`, so an unrelated future image
    // elsewhere on the page can never turn this into a false failure), and
    // its onerror handler never ran.
    expect(card.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();

    // Approve / Reject are offered, and the send control is gone while the
    // turn -- including this pending approval -- is still in flight.
    expect(screen.getByRole("button", { name: "Approve & run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

    await act(async () => {
      stream.settle("done");
    });
  });

  it("says on a terminal command's card that it runs with the user's full account permissions, and only there", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);
    await user.type(screen.getByLabelText("Message to Jarvis"), "list files");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    act(() => {
      stream.getOptions().onToolCall?.({
        requestId: "req-1",
        kind: "tool_call",
        status: "launch_tool",
        callId: "call-1",
        summary: "Launch nmap",
      });
    });
    await screen.findByTestId("assistant-approval-card");
    expect(screen.queryByTestId("assistant-approval-account-note")).toBeNull();

    act(() => {
      stream.getOptions().onToolCall?.({
        requestId: "req-1",
        kind: "tool_call",
        status: "terminal_run",
        callId: "call-2",
        summary: "Run in terminal: dir",
      });
    });
    expect(await screen.findByTestId("assistant-approval-account-note")).toHaveTextContent(
      "full Windows account permissions",
    );

    await act(async () => {
      stream.settle("done");
    });
  });

  it("calls approveTool(requestId, callId, true) on Approve, then clears the card and renders the tool_result inline", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Jarvis"), "hi");
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

    expect(approveTool).toHaveBeenCalledWith("req-1", "call-1", true);

    act(() => {
      stream.getOptions().onToolResult?.({
        requestId: "req-1",
        kind: "tool_result",
        callId: "call-1",
        summary: "qutra-lab-user",
      });
    });

    await waitFor(() =>
      expect(screen.queryByTestId("assistant-approval-card")).toBeNull(),
    );
    expect(screen.getByText("qutra-lab-user")).toBeInTheDocument();

    await act(async () => {
      stream.settle("done");
    });
  });

  it("calls approveTool(requestId, callId, false) on Reject", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Jarvis"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    act(() => {
      stream.getOptions().onToolCall?.({
        requestId: "req-1",
        kind: "tool_call",
        callId: "call-1",
        summary: "Launch tool: tool-nmap",
      });
    });
    await screen.findByTestId("assistant-approval-card");

    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(approveTool).toHaveBeenCalledWith("req-1", "call-1", false);

    await act(async () => {
      stream.fail(new AssistantBlockedError("approval_rejected"));
    });

    await waitFor(() =>
      expect(screen.queryByTestId("assistant-approval-card")).toBeNull(),
    );
  });

  it("clears a pending card on any terminal event, even without a tool_result", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Jarvis"), "hi");
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

    // Nobody answered the card before the broker's deadline fired.
    await act(async () => {
      stream.fail(new AssistantTimeoutError("approval_timeout"));
    });

    await waitFor(() =>
      expect(screen.queryByTestId("assistant-approval-card")).toBeNull(),
    );
    // The turn is over: the composer's send control is usable again.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument(),
    );
  });

  it("clears tool_result rows (and any pending card) on Clear conversation, not just the transcript", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Jarvis"), "hi");
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

    act(() => {
      stream.getOptions().onToolResult?.({
        requestId: "req-1",
        kind: "tool_result",
        callId: "call-1",
        summary: "qutra-lab-user",
      });
    });
    await screen.findByText("qutra-lab-user");

    await act(async () => {
      stream.settle("done");
    });

    // The turn is over: the real command output is sitting in the
    // transcript with nothing left pending.
    expect(screen.getByText("qutra-lab-user")).toBeInTheDocument();

    await clearConversation(user);

    // Not just the message transcript -- the tool_result row too, which
    // would otherwise stay on screen with no way to remove it.
    expect(screen.queryByTestId("assistant-tool-result")).toBeNull();
    expect(screen.queryByText("qutra-lab-user")).toBeNull();
  });

  it("cancels the in-flight turn first on Clear conversation, and ignores a late result", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Jarvis"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    act(() => {
      stream.getOptions().onToolCall?.({
        requestId: "req-clear",
        kind: "tool_call",
        callId: "call-clear",
        summary: "Run in terminal: whoami",
      });
    });
    await screen.findByTestId("assistant-approval-card");

    const signal = stream.getOptions().signal;
    await clearConversation(user);

    expect(signal?.aborted).toBe(true);
    expect(approveTool).toHaveBeenCalledWith("req-clear", "call-clear", false);
    expect(screen.queryByTestId("assistant-approval-card")).toBeNull();

    await act(async () => {
      stream.getOptions().onToken?.("late answer");
      stream.settle("late answer");
    });

    expect(transcript().queryByText("late answer")).toBeNull();
    // The question was saved when it was sent; the clear erased it, and the
    // late answer was never written.
    await waitFor(() =>
      expect(
        getDb()
          .collection("conversations")
          .getAll()
          .flatMap((c) => c.messages),
      ).toEqual([]),
    );
  });

  it("announces the proposed action to assistive tech instead of claiming it is still generating", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Jarvis"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    // Before any tool_call arrives, the turn is genuinely generating.
    expect(screen.getByRole("status")).toHaveTextContent("Generating…");

    act(() => {
      stream.getOptions().onToolCall?.({
        requestId: "req-1",
        kind: "tool_call",
        callId: "call-1",
        summary: "Run in terminal: whoami",
      });
    });
    await screen.findByTestId("assistant-approval-card");

    // The turn is blocked on a human decision now -- the live region must
    // say so, not "Generating...", and it must name the proposed action.
    const status = screen.getByRole("status");
    expect(status).not.toHaveTextContent("Generating…");
    expect(status).toHaveTextContent("Run in terminal: whoami");

    await act(async () => {
      stream.settle("done");
    });
  });

  it("logs and surfaces an error when a tool_call event arrives with no callId, instead of silently waiting out the deadline", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Jarvis"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    act(() => {
      stream.getOptions().onToolCall?.({
        requestId: "req-1",
        kind: "tool_call",
        // No callId: a malformed proposal that must not be silently dropped.
        summary: "Run in terminal: whoami",
      });
    });

    expect(screen.queryByTestId("assistant-approval-card")).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong. Try again.",
    );

    consoleError.mockRestore();
    await act(async () => {
      stream.settle("done");
    });
  });

  it("logs the caught error when a turn fails with something other than a known assistant error", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new TypeError("boom");

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Jarvis"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    await act(async () => {
      stream.fail(boom);
    });

    expect(consoleError).toHaveBeenCalledWith(boom);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong. Try again.",
    );

    consoleError.mockRestore();
  });

  it("never logs for the known assistant error branches (approval rejected, timeout)", async () => {
    seedDb();
    const stream = armStreamChat();
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Jarvis"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    await act(async () => {
      stream.fail(new AssistantTimeoutError("approval_timeout"));
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("renders an auto-approved read result with no preceding approval card", async () => {
    const db = seedDb();
    db.prefs.set({ assistantAutoApproveReads: true });
    const stream = armStreamChat();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Jarvis"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    // With auto-approve on, the broker never emits a tool_call for a
    // read-only call -- straight to the result. No card ever appears.
    act(() => {
      stream.getOptions().onToolResult?.({
        requestId: "req-1",
        kind: "tool_result",
        callId: "call-1",
        summary: "project: qutra-lab",
      });
    });

    expect(screen.queryByTestId("assistant-approval-card")).toBeNull();
    expect(await screen.findByText("project: qutra-lab")).toBeInTheDocument();

    await act(async () => {
      stream.settle("done");
    });
  });
});
