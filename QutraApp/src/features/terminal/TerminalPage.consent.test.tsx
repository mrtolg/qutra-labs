import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Database, setDbForTesting, getDb } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { createBrowserTerminal } from "@/lib/bridge/terminal";
import { useTerminalTabs } from "./terminalTabs";
import TerminalPage from "./TerminalPage";

/**
 * Terminal is gated behind the app's one-time Private Lab consent (ADR
 * 0007): the native runtime alone is not enough to see the live surface,
 * and once the preference is granted the consent prompt never comes back.
 */

function seedDb(privateToolsEnabled: boolean) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ privateToolsEnabled });
  setDbForTesting(db);
  return db;
}

/** A bridge whose terminal reports native-available, unlike the browser stub. */
function nativeBridge(requestGrant = vi.fn().mockResolvedValue(true)): DesktopBridge {
  return {
    mode: "tauri",
    terminal: {
      available: () => true,
      resolvedShell: vi.fn().mockResolvedValue({ program: "powershell.exe", kind: "powershell" }),
      open: vi.fn().mockResolvedValue("sess-1"),
      openTool: vi.fn().mockResolvedValue("sess-1"),
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
      available: () => true,
      requestGrant,
    },
  } as unknown as DesktopBridge;
}

function browserBridge(): DesktopBridge {
  return {
    mode: "browser",
    terminal: createBrowserTerminal(),
    toolSupervisor: {
      requestGrant: vi.fn().mockResolvedValue(false),
    },
  } as unknown as DesktopBridge;
}

function renderTerminal() {
  return render(
    <MemoryRouter>
      <TerminalPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  setDbForTesting(null);
  resetBridgeForTesting();
  useTerminalTabs.setState({ tabs: [], activeId: null, reseedAllowed: true });
  vi.restoreAllMocks();
});

describe("TerminalPage consent gate", () => {
  it("shows the honest native-required state in the browser bridge, with no consent UI", () => {
    seedDb(false);
    setBridgeForTesting(browserBridge());
    renderTerminal();

    expect(screen.getByTestId("terminal-native-required")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-consent-required")).toBeNull();
    expect(screen.queryByTestId("terminal-enable")).toBeNull();
  });

  it("shows the Private Lab consent gate when native is available but consent is not granted", () => {
    seedDb(false);
    setBridgeForTesting(nativeBridge());
    renderTerminal();

    expect(screen.getByTestId("terminal-consent-required")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-enable")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-surface")).toBeNull();
    expect(screen.queryByTestId("terminal-native-required")).toBeNull();
  });

  it("enabling grants native consent then persists the preference, so it is never asked again", async () => {
    const requestGrant = vi.fn().mockResolvedValue(true);
    seedDb(false);
    setBridgeForTesting(nativeBridge(requestGrant));
    const user = userEvent.setup();
    renderTerminal();

    await user.click(screen.getByTestId("terminal-enable"));

    await waitFor(() => expect(requestGrant).toHaveBeenCalledWith("en"));
    await waitFor(() =>
      expect(getDb().prefs.get().privateToolsEnabled).toBe(true),
    );
    expect(getDb().prefs.get().localAssistantEnabled).toBe(false);
    expect(getDb().prefs.get().assistantAgentToolsEnabled).toBe(false);
  });

  it("does not show the consent gate once Private Lab is already enabled", async () => {
    seedDb(true);
    setBridgeForTesting(nativeBridge());
    renderTerminal();

    await waitFor(() => expect(screen.queryByTestId("terminal-consent-required")).toBeNull());
    expect(screen.queryByTestId("terminal-enable")).toBeNull();
  });

  it("opens a default shell tab titled with the resolved program", async () => {
    seedDb(true);
    setBridgeForTesting(nativeBridge());
    renderTerminal();

    await waitFor(() => expect(screen.getAllByTestId("work-tab")).toHaveLength(1));
    expect(useTerminalTabs.getState().tabs[0]?.title).toBe("powershell.exe");
    expect(useTerminalTabs.getState().tabs[0]?.spec).toEqual({ kind: "shell", shell: "pwsh" });
    expect(screen.getByTestId("terminal-kill-all")).toBeInTheDocument();
  });

  it("stop-all closes every native session and does not auto-reseed a shell", async () => {
    const terminal = nativeBridge();
    seedDb(true);
    setBridgeForTesting(terminal);
    const user = userEvent.setup();
    renderTerminal();

    await waitFor(() => expect(useTerminalTabs.getState().tabs).toHaveLength(1));

    await user.click(screen.getByTestId("terminal-kill-all"));

    expect(terminal.terminal.closeAll).toHaveBeenCalled();
    expect(useTerminalTabs.getState().tabs).toHaveLength(0);
    expect(useTerminalTabs.getState().reseedAllowed).toBe(false);
  });

  it("offers a new terminal once every tab is closed, instead of a blank", async () => {
    seedDb(true);
    setBridgeForTesting(nativeBridge());
    const user = userEvent.setup();
    renderTerminal();

    await waitFor(() => expect(useTerminalTabs.getState().tabs).toHaveLength(1));
    await user.click(screen.getByTestId("terminal-kill-all"));
    const empty = screen.getByTestId("terminal-empty");
    expect(empty).toHaveTextContent("No terminal open");
    await user.click(within(empty).getByRole("button", { name: "New terminal" }));
    expect(useTerminalTabs.getState().tabs).toHaveLength(1);
    expect(screen.queryByTestId("terminal-empty")).toBeNull();
  });

  it("the + button opens another shell tab", async () => {
    seedDb(true);
    setBridgeForTesting(nativeBridge());
    const user = userEvent.setup();
    renderTerminal();

    await waitFor(() => expect(useTerminalTabs.getState().tabs).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "New terminal" }));

    expect(useTerminalTabs.getState().tabs).toHaveLength(2);
    expect(screen.getAllByTestId("work-tab")).toHaveLength(2);
  });
});
