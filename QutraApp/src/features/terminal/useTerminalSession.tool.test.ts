import { useEffect, useRef } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalSession } from "./useTerminalSession";
import type { TerminalLoaders, XtermInstance, FitAddonInstance } from "./useTerminalSession";
import type { TerminalController } from "@/lib/bridge/terminal";

/**
 * The interactive Launch route (`ToolLabPanel.launch`) opens a `tool` tab
 * spec naming only an installation id, never a path or a working directory
 * (`terminal_open_tool` resolves both server-side, the same identity gate
 * the batch and gui routes apply). This test proves
 * `attach` routes a `tool` spec to `controller.openTool` with exactly the
 * installation id and args -- no `cwd`.
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
  };
}

function useHarness(controller: TerminalController, loaders: TerminalLoaders) {
  const elRef = useRef<HTMLElement>(document.createElement("div"));
  const session = useTerminalSession(
    controller,
    { kind: "tool", installationId: "installation-1", args: ["--target", "example.com"] },
    loaders,
  );
  useEffect(() => {
    void session.attach(elRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.attach]);
  return session;
}

describe("useTerminalSession tool spec routing", () => {
  it("routes a tool spec to controller.openTool with the installation id and args, no cwd", async () => {
    const controller = fakeController();
    const loaders = fakeLoaders();

    renderHook(() => useHarness(controller, loaders));

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.openTool).toHaveBeenCalledWith({
      installationId: "installation-1",
      args: ["--target", "example.com"],
      cols: 80,
      rows: 24,
    });
  });
});
