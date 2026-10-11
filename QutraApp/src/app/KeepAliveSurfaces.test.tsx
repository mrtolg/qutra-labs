import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import type { AssistantStreamEvent } from "@/lib/localAssistant/client";
import { localAssistant } from "@/lib/localAssistant/client";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import { KeepAliveSurfaces } from "./KeepAliveSurfaces";

vi.mock("@/lib/localAssistant/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/localAssistant/client")>();
  return {
    ...actual,
    localAssistant: {
      available: vi.fn().mockReturnValue(true),
      // The enabled chat probes readiness on mount (security review #2).
      checkHealth: vi.fn().mockResolvedValue({ status: "ready", models: [] }),
      listModels: vi.fn().mockResolvedValue({ status: "unavailable", models: [] }),
      streamChat: vi.fn(),
      approveTool: vi.fn().mockResolvedValue({ resolved: true }),
    },
  };
});

const streamChat = vi.mocked(localAssistant.streamChat);
const approveTool = vi.mocked(localAssistant.approveTool);

Element.prototype.scrollTo = vi.fn();

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

function nativeBridge(): DesktopBridge {
  return {
    mode: "tauri",
    terminal: {
      available: () => true,
      resolvedShell: vi.fn().mockResolvedValue({ program: "powershell.exe", kind: "powershell" }),
      open: vi.fn().mockResolvedValue("sess-keep"),
      openTool: vi.fn().mockResolvedValue("sess-keep"),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      closeAll: vi.fn().mockResolvedValue({ requested: 0, failed: [] }),
      onData: vi.fn().mockResolvedValue(() => {}),
      scrollback: vi.fn().mockResolvedValue({ text: "", cursor: 0 }),
      listSessions: vi.fn().mockResolvedValue({ runtimeId: "browser", revision: 0, sessions: [] }),
      onSession: vi.fn().mockResolvedValue(() => {}),
    },
    toolSupervisor: {
      consentGranted: vi.fn().mockResolvedValue(true),
      requestGrant: vi.fn().mockResolvedValue(true),
      revoke: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as DesktopBridge;
}

function seedDb(overrides: Record<string, unknown> = {}) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({
    privateToolsEnabled: true,
    localAssistantEnabled: true,
    assistantContextEnabled: false,
    ...overrides,
  });
  setDbForTesting(db);
  return db;
}

function Harness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/overview")}>
        Go home
      </button>
      <button type="button" onClick={() => navigate("/terminal")}>
        Go terminal
      </button>
      <button type="button" onClick={() => navigate("/jarvis")}>
        Go jarvis
      </button>
      <KeepAliveSurfaces />
    </>
  );
}

function renderLifecycle(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<Harness />}>
          <Route path="overview" element={<div>Home surface</div>} />
          <Route path="terminal" element={null} />
          <Route path="jarvis" element={null} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

type StreamOptions = {
  signal?: AbortSignal;
  onToolCall?: (event: AssistantStreamEvent) => void;
};

function armStreamChat() {
  let options!: StreamOptions;
  streamChat.mockImplementationOnce((_config, _messages, opts) => {
    options = opts ?? {};
    return new Promise<string>(() => {});
  });
  return { getOptions: () => options };
}

afterEach(() => {
  resetBridgeForTesting();
  useTerminalTabs.setState({ tabs: [], activeId: null, reseedAllowed: true });
  vi.clearAllMocks();
});

describe("session and turn ownership", () => {
  it("keeps a terminal session alive across a round trip away from /terminal", async () => {
    seedDb();
    const bridge = nativeBridge();
    setBridgeForTesting(bridge);
    const user = userEvent.setup();

    renderLifecycle("/terminal");

    const surface = await screen.findByTestId("terminal-surface");
    const tabId = useTerminalTabs.getState().tabs[0]?.id;
    expect(tabId).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Go home" }));
    expect(screen.getByTestId("terminal-surface")).toBe(surface);
    expect(screen.getByTestId("keepalive-terminal")).not.toBeVisible();
    expect(useTerminalTabs.getState().tabs[0]?.id).toBe(tabId);
    expect(bridge.terminal.close).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Go terminal" }));
    expect(screen.getByTestId("terminal-surface")).toBe(surface);
    expect(screen.getByTestId("keepalive-terminal")).toBeVisible();
    expect(useTerminalTabs.getState().tabs[0]?.id).toBe(tabId);
    expect(bridge.terminal.close).not.toHaveBeenCalled();
  });

  it("keeps a pending approval pending after a round trip to Home", async () => {
    seedDb();
    setBridgeForTesting(nativeBridge());
    const stream = armStreamChat();
    const user = userEvent.setup();

    renderLifecycle("/jarvis");

    // Qutra is a lazy chunk: its first import can outlast findBy's 1 s
    // default when the whole suite runs at once.
    await user.type(
      await screen.findByLabelText("Message to Qutra", undefined, { timeout: 10_000 }),
      "hi",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    act(() => {
      stream.getOptions().onToolCall?.({
        requestId: "req-keep",
        kind: "tool_call",
        callId: "call-keep",
        summary: "Run in terminal: whoami",
      });
    });
    expect(await screen.findByTestId("assistant-approval-card")).toBeVisible();
    expect(stream.getOptions().signal?.aborted).toBe(false);

    await user.click(screen.getByRole("button", { name: "Go home" }));
    expect(screen.getByTestId("keepalive-jarvis")).not.toBeVisible();
    expect(approveTool).not.toHaveBeenCalled();
    expect(stream.getOptions().signal?.aborted).toBe(false);

    await user.click(screen.getByRole("button", { name: "Go jarvis" }));
    expect(screen.getByTestId("keepalive-jarvis")).toBeVisible();
    expect(screen.getByTestId("assistant-approval-card")).toBeVisible();
    expect(approveTool).not.toHaveBeenCalled();
    expect(stream.getOptions().signal?.aborted).toBe(false);
  });
});
