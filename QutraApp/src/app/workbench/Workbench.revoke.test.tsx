import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Database, setDbForTesting, getDb } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import { Workbench } from "./Workbench";

function seedDb(privateToolsEnabled: boolean) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ privateToolsEnabled });
  setDbForTesting(db);
  return db;
}

function nativeBridge(): DesktopBridge {
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
      consentGranted: vi.fn().mockResolvedValue(true),
      requestGrant: vi.fn().mockResolvedValue(true),
      revoke: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as DesktopBridge;
}

afterEach(() => {
  setDbForTesting(null);
  resetBridgeForTesting();
  useTerminalTabs.setState({ tabs: [], activeId: null, reseedAllowed: true });
});

describe("Workbench Private Lab revoke", () => {
  it("closes managed terminals that were created before Terminal was visited", async () => {
    seedDb(true);
    const bridge = nativeBridge();
    setBridgeForTesting(bridge);
    useTerminalTabs.getState().openAttachedTab({
      sessionId: "sess-before-visit",
      title: "Assistant terminal",
    });

    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <Routes>
          <Route path="*" element={<Workbench />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId("keepalive-terminal")).toBeNull();
    expect(useTerminalTabs.getState().tabs).toHaveLength(1);

    act(() => {
      getDb().prefs.set({ privateToolsEnabled: false });
    });

    await waitFor(() => expect(bridge.terminal.closeAll).toHaveBeenCalled());
    expect(useTerminalTabs.getState().tabs).toHaveLength(0);
    expect(useTerminalTabs.getState().reseedAllowed).toBe(false);
  });
});
