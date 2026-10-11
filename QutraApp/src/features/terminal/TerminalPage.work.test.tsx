import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import type { TerminalSessionInfo } from "@/lib/bridge/terminal";
import { emptyFacts, useTerminalSessionFacts } from "./terminalSessionFacts";
import { useTerminalTabs } from "./terminalTabs";
import TerminalPage from "./TerminalPage";

/* The Work surface is one strip of session tabs over
   the terminal, and a status strip under it that states the active session's
   facts as Rust reports them: live or ended, program, where it started,
   PID, how long it ran, and the shell's exit code once it ended. */

const NOW = 1_759_700_000_000;

function nativeBridge(): DesktopBridge {
  return {
    mode: "tauri",
    terminal: {
      available: () => true,
      resolvedShell: vi.fn().mockResolvedValue({ program: "pwsh.exe", kind: "pwsh" }),
      open: vi.fn().mockResolvedValue("sess-1"),
      openTool: vi.fn().mockResolvedValue("sess-1"),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      closeAll: vi.fn().mockResolvedValue({ requested: 0, failed: [] }),
      onData: vi.fn().mockResolvedValue(() => {}),
      scrollback: vi.fn().mockResolvedValue({ text: "", cursor: 0 }),
      listSessions: vi.fn().mockResolvedValue({ runtimeId: "rt", revision: 0, sessions: [] }),
      onSession: vi.fn().mockResolvedValue(() => {}),
    },
    toolSupervisor: { available: () => true, requestGrant: vi.fn() },
  } as unknown as DesktopBridge;
}

function info(overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return {
    runtimeId: "rt",
    sessionId: "sess-1",
    revision: 1,
    origin: "user",
    installationId: null,
    state: "running",
    ioState: "open",
    pid: 4242,
    programName: "pwsh.exe",
    startedAt: NOW - 3_723_000,
    elapsedMs: 3_723_000,
    initialCwd: "C:\\src\\qutra-app",
    cwdSource: "spawn",
    exit: null,
    ...overrides,
  };
}

function facts(session: TerminalSessionInfo, status: "live" | "unavailable" = "live") {
  useTerminalSessionFacts.setState(
    { runtimeId: "rt", revision: session.revision, byId: { [session.sessionId]: session }, status },
    true,
  );
}

function renderWork() {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ privateToolsEnabled: true });
  setDbForTesting(db);
  setBridgeForTesting(nativeBridge());
  useTerminalTabs.setState({
    tabs: [
      { id: "t1", title: "pwsh.exe", spec: { kind: "attached", sessionId: "sess-1" }, sessionId: "sess-1" },
      { id: "t2", title: "notes", spec: { kind: "attached", sessionId: "sess-2" }, sessionId: "sess-2" },
    ],
    activeId: "t1",
    reseedAllowed: true,
  });
  return render(
    <MemoryRouter>
      <TerminalPage />
    </MemoryRouter>,
  );
}

const status = () => screen.getByRole("region", { name: "Session status" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  setDbForTesting(null);
  resetBridgeForTesting();
  useTerminalTabs.setState({ tabs: [], activeId: null, reseedAllowed: true });
  useTerminalSessionFacts.setState(emptyFacts, true);
});

describe("Work surface", () => {
  it("states the live session's facts under the terminal", () => {
    facts(info());
    renderWork();

    const strip = status();
    expect(within(strip).getByText("Live session")).toBeInTheDocument();
    expect(within(strip).getByText("pwsh.exe")).toBeInTheDocument();
    expect(within(strip).getByText("C:\\src\\qutra-app")).toBeInTheDocument();
    expect(within(strip).getByText("PID 4242")).toBeInTheDocument();
    expect(within(strip).getByText("up 01:02:03")).toBeInTheDocument();
    expect(within(strip).queryByText(/exit/)).toBeNull();
  });

  it("shows the shell's exit code once the session ended", () => {
    facts(info({ state: "exited", exit: { code: 1, reason: "natural", endedAt: NOW }, elapsedMs: 65_000 }));
    renderWork();

    const strip = status();
    expect(within(strip).getByText("Ended")).toBeInTheDocument();
    expect(within(strip).getByText("exit 1")).toBeInTheDocument();
    expect(within(strip).getByText("ran 00:01:05")).toBeInTheDocument();
    expect(within(strip).queryByText("Live session")).toBeNull();
  });

  it("says when the app stopped the session", () => {
    facts(info({ state: "exited", exit: { code: 0, reason: "stopped", endedAt: NOW } }));
    renderWork();
    expect(within(status()).getByText("Stopped")).toBeInTheDocument();
    expect(within(status()).getByText("exit 0")).toBeInTheDocument();
  });

  it("never shows stale facts as current", () => {
    facts(info(), "unavailable");
    renderWork();

    const strip = status();
    expect(within(strip).getByText("Session details unavailable")).toBeInTheDocument();
    expect(within(strip).queryByText("PID 4242")).toBeNull();
    expect(within(strip).queryByText("Live session")).toBeNull();
  });

  it("follows the active tab", () => {
    useTerminalSessionFacts.setState(
      {
        runtimeId: "rt",
        revision: 2,
        byId: {
          "sess-1": info(),
          "sess-2": info({ sessionId: "sess-2", pid: 77, revision: 2 }),
        },
        status: "live",
      },
      true,
    );
    renderWork();

    fireEvent.click(screen.getByRole("button", { name: "notes" }));
    expect(within(status()).getByText("PID 77")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "notes" })).toHaveAttribute("aria-current", "true");
  });

  it("closes a tab from its own close button", () => {
    facts(info());
    renderWork();

    fireEvent.click(screen.getByRole("button", { name: "Close notes" }));
    expect(useTerminalTabs.getState().tabs.map((t) => t.id)).toEqual(["t1"]);
  });

  it("counts the running time up while the session is live", () => {
    facts(info());
    renderWork();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(within(status()).getByText("up 01:02:05")).toBeInTheDocument();
  });
});
