import { useEffect, useRef } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalSession, wireFromId } from "./useTerminalSession";
import type { TerminalLoaders, XtermInstance, FitAddonInstance } from "./useTerminalSession";
import type { TerminalController } from "@/lib/bridge/terminal";

/**
 * An `attached` spec names a PTY session the broker already
 * opened (currently: the assistant's `terminal_run` tool opening its own
 * session, `src-tauri/src/assistant/tools.rs::execute_terminal_run`). This
 * proves `attach` routes that spec straight to `wireFromId` with the given
 * session id -- never through `controller.open`/`openTool`, which would
 * open a *second*, unrelated session instead of binding to the one that
 * already exists.
 */

class FakeTerminal implements XtermInstance {
  cols = 80;
  rows = 24;
  options: XtermInstance["options"] = {};
  open = vi.fn();
  loadAddon = vi.fn();
  onData = vi.fn();
  write = vi.fn();
  dispose = vi.fn();
}

class FakeFitAddon implements FitAddonInstance {
  fit = vi.fn();
}

function fakeLoaders(): TerminalLoaders {
  return {
    loadTerminal: () => Promise.resolve({ Terminal: FakeTerminal as unknown as new (opts: Record<string, unknown>) => XtermInstance }),
    loadFit: () => Promise.resolve({ FitAddon: FakeFitAddon as unknown as new () => FitAddonInstance }),
    loadCss: () => Promise.resolve(undefined),
  };
}

function fakeController(): TerminalController {
  return {
    available: () => true,
    resolvedShell: vi.fn().mockResolvedValue({ program: "pwsh.exe", kind: "pwsh" }),
    open: vi.fn().mockResolvedValue("sess-should-not-be-used"),
    openTool: vi.fn().mockResolvedValue("sess-should-not-be-used"),
    write: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue({ requested: 0, failed: [] }),
    onData: vi.fn().mockResolvedValue(() => {}),
    scrollback: vi.fn().mockResolvedValue({ text: "", cursor: 0 }),
    listSessions: vi.fn().mockResolvedValue({ runtimeId: "browser", revision: 0, sessions: [] }),
    onSession: vi.fn().mockResolvedValue(() => {}),
  };
}

function useHarness(controller: TerminalController, loaders: TerminalLoaders) {
  const elRef = useRef<HTMLElement>(document.createElement("div"));
  const session = useTerminalSession(
    controller,
    { kind: "attached", sessionId: "sess-agent-opened" },
    loaders,
  );
  useEffect(() => {
    void session.attach(elRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.attach]);
  return session;
}

describe("useTerminalSession attached spec routing", () => {
  it("wires the given session id via wireFromId without opening a new session", async () => {
    const controller = fakeController();
    const loaders = fakeLoaders();

    renderHook(() => useHarness(controller, loaders));

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.open).not.toHaveBeenCalled();
    expect(controller.openTool).not.toHaveBeenCalled();
    // `onData` is the one call `wireFromId` makes to bind the surface --
    // proof the given id was actually wired, not silently dropped.
    expect(controller.onData).toHaveBeenCalledTimes(1);
  });

  it("(unit, no React) wireFromId binds an already-open id verbatim", async () => {
    const controller = fakeController();
    const xterm = new FakeTerminal();

    const session = await wireFromId(controller, xterm, "sess-already-open");

    expect(session.id).toBe("sess-already-open");
    expect(controller.open).not.toHaveBeenCalled();
    expect(controller.openTool).not.toHaveBeenCalled();
  });
});
