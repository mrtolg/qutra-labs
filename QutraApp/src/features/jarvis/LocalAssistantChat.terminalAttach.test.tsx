import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  type AssistantStreamEvent,
  localAssistant,
} from "@/lib/localAssistant/client";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import { LocalAssistantChat } from "./LocalAssistantChat";

/* A `terminal_run` that opened its own session (no
   `sessionId` in the model's call) is otherwise invisible -- nothing in the
   renderer ever wires up its `terminal://data`, so the PTY runs with no
   listener and survives until app exit. `onToolResult` must open an
   `attached` terminal tab for it whenever the result carries a `sessionId`,
   so the session becomes a real, inspectable tab -- without navigating the
   user away from this chat mid-conversation. */

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

const streamChat = vi.mocked(localAssistant.streamChat);

Element.prototype.scrollTo = vi.fn();

type StreamOptions = {
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onToolCall?: (event: AssistantStreamEvent) => void;
  onToolResult?: (event: AssistantStreamEvent) => void;
};

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

beforeEach(() => {
  useTerminalTabs.setState({ tabs: [], activeId: null });
});

afterEach(() => {
  setDbForTesting(null);
  vi.clearAllMocks();
  useTerminalTabs.setState({ tabs: [], activeId: null });
});

async function runOneApprovedTurn(
  toolResult: AssistantStreamEvent,
) {
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
      summary: "Run in a new terminal session: whoami",
    });
  });
  await screen.findByTestId("assistant-approval-card");

  act(() => {
    stream.getOptions().onToolResult?.(toolResult);
  });

  await act(async () => {
    stream.settle("done");
  });
}

describe("LocalAssistantChat opens an attached terminal tab for a terminal_run result", () => {
  it("opens exactly one attached tab when tool_result carries a sessionId", async () => {
    await runOneApprovedTurn({
      requestId: "req-1",
      kind: "tool_result",
      callId: "call-1",
      summary: "Sent to terminal session sess-agent-42",
      sessionId: "sess-agent-42",
    });

    await waitFor(() => {
      expect(useTerminalTabs.getState().tabs).toHaveLength(1);
    });
    const tab = useTerminalTabs.getState().tabs[0];
    expect(tab.spec).toEqual({ kind: "attached", sessionId: "sess-agent-42" });
    // Title makes the tab's origin obvious -- it was opened by the
    // assistant, not by the user clicking "+" on the Terminal page.
    expect(tab.title).toBe("Assistant terminal");
  });

  it("opens no tab when tool_result carries no sessionId (e.g. launch_tool, read_context)", async () => {
    await runOneApprovedTurn({
      requestId: "req-1",
      kind: "tool_result",
      callId: "call-1",
      summary: "Launched tool Nmap Scanner",
    });

    await waitFor(() => expect(screen.queryByTestId("assistant-approval-card")).toBeNull());
    expect(useTerminalTabs.getState().tabs).toHaveLength(0);
  });
});
