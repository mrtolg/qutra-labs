import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
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

function Boom(): never {
  throw new Error("files exploded");
}

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

function seedDb() {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({
    privateToolsEnabled: true,
    localAssistantEnabled: true,
    assistantContextEnabled: false,
  });
  setDbForTesting(db);
  return db;
}

function Harness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/files")}>
        Go files
      </button>
      <button type="button" onClick={() => navigate("/terminal")}>
        Go terminal
      </button>
      <KeepAliveSurfaces />
    </>
  );
}

afterEach(() => {
  resetBridgeForTesting();
  useTerminalTabs.setState({ tabs: [], activeId: null, reseedAllowed: true });
});

describe("separate keep-alive error boundaries", () => {
  it("a render error in Files does not unmount Terminal or close its PTY", async () => {
    seedDb();
    const bridge = nativeBridge();
    setBridgeForTesting(bridge);
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <MemoryRouter initialEntries={["/terminal"]}>
        <Routes>
          <Route path="/" element={<Harness />}>
            <Route path="terminal" element={null} />
            <Route path="files" element={<Boom />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const surface = await screen.findByTestId("terminal-surface");
    const tabId = useTerminalTabs.getState().tabs[0]?.id;
    expect(tabId).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Go files" }));

    expect(
      await screen.findByText("This screen failed to load"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("keepalive-terminal")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-surface")).toBe(surface);
    expect(useTerminalTabs.getState().tabs[0]?.id).toBe(tabId);
    expect(bridge.terminal.close).not.toHaveBeenCalled();
    expect(bridge.terminal.closeAll).not.toHaveBeenCalled();
  });
});
