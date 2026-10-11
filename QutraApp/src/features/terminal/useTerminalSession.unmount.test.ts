import { useEffect, useRef } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalSession } from "./useTerminalSession";
import type {
  TerminalCtor,
  TerminalLoaders,
  XtermInstance,
  FitAddonInstance,
} from "./useTerminalSession";
import type { TerminalController } from "@/lib/bridge/terminal";
import type { TerminalTabSpec } from "./terminalTabs";

/** Fake xterm Terminal: just enough surface for `attach` to drive. */
class FakeTerminal implements XtermInstance {
  cols = 80;
  rows = 24;
  disposed = false;
  options: XtermInstance["options"] = {};
  open = vi.fn();
  loadAddon = vi.fn();
  onData = vi.fn();
  write = vi.fn();
  dispose = vi.fn(() => {
    this.disposed = true;
  });
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

/** Fake controller whose `open()` resolves only when the test says so —
 * this is how we simulate "unmount happened while attach was still
 * awaiting a slow step". */
function deferredController() {
  let resolveOpen: (id: string) => void = () => {};
  const openPromise = new Promise<string>((resolve) => {
    resolveOpen = resolve;
  });
  const controller: TerminalController = {
    available: () => true,
    resolvedShell: vi.fn().mockResolvedValue({ program: "pwsh.exe", kind: "pwsh" }),
    open: vi.fn().mockReturnValue(openPromise),
    openTool: vi.fn().mockReturnValue(openPromise),
    write: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue({ requested: 0, failed: [] }),
    onData: vi.fn().mockResolvedValue(() => {}),
    scrollback: vi.fn().mockResolvedValue({ text: "", cursor: 0 }),
    listSessions: vi.fn().mockResolvedValue({ runtimeId: "browser", revision: 0, sessions: [] }),
    onSession: vi.fn().mockResolvedValue(() => {}),
  };
  return { controller, resolveOpen };
}

function fakeController(overrides: Partial<TerminalController> = {}): TerminalController {
  return {
    available: () => true,
    resolvedShell: vi.fn().mockResolvedValue({ program: "pwsh.exe", kind: "pwsh" }),
    open: vi.fn().mockResolvedValue("sess-1"),
    openTool: vi.fn(),
    write: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue({ requested: 0, failed: [] }),
    onData: vi.fn().mockResolvedValue(() => {}),
    scrollback: vi.fn().mockResolvedValue({ text: "", cursor: 0 }),
    listSessions: vi.fn().mockResolvedValue({ runtimeId: "browser", revision: 0, sessions: [] }),
    onSession: vi.fn().mockResolvedValue(() => {}),
    ...overrides,
  };
}

const SHELL_SPEC: TerminalTabSpec = { kind: "shell", shell: "pwsh" };
const ATTACHED_SPEC: TerminalTabSpec = {
  kind: "attached",
  sessionId: "sess-attached",
};

/** Harness mirroring TerminalTab: attach on mount, dispose on unmount. */
function useHarness(
  controller: TerminalController,
  loaders: TerminalLoaders,
  spec: TerminalTabSpec = SHELL_SPEC,
) {
  const elRef = useRef<HTMLElement>(document.createElement("div"));
  const session = useTerminalSession(controller, spec, loaders);
  useEffect(() => {
    void session.attach(elRef.current);
    return () => {
      void session.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.attach, session.dispose]);
  return session;
}

function deferredLoaders() {
  let resolveTerminal!: (value: { Terminal: TerminalCtor }) => void;
  const terminalPromise = new Promise<{ Terminal: TerminalCtor }>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    resolveTerminal: () =>
      resolveTerminal({
        Terminal: FakeTerminal as unknown as TerminalCtor,
      }),
    loaders: {
      loadTerminal: () => terminalPromise,
      loadFit: () =>
        Promise.resolve({
          FitAddon: FakeFitAddon as unknown as new () => FitAddonInstance,
        }),
      loadCss: () => Promise.resolve(undefined),
    } satisfies TerminalLoaders,
  };
}

describe("useTerminalSession unmount-during-attach", () => {
  it("does not let a cancelled StrictMode attach leak a PTY", async () => {
    const opened: string[] = [];
    const controller = fakeController({
      open: vi.fn().mockImplementation(() => {
        const id = `sess-${opened.length + 1}`;
        opened.push(id);
        return Promise.resolve(id);
      }),
    });
    const { loaders, resolveTerminal } = deferredLoaders();

    const { unmount } = renderHook(() => useHarness(controller, loaders), {
      reactStrictMode: true,
    });

    resolveTerminal();
    await waitFor(() => expect(opened.length).toBeGreaterThan(0));
    unmount();
    await waitFor(() => {
      const closed = vi.mocked(controller.close).mock.calls.map(([id]) => id);
      expect(closed.sort()).toEqual([...opened].sort());
    });
  });

  it("closes the PTY a cancelled attach acquired while a later attach proceeds", async () => {
    const pending: Array<(id: string) => void> = [];
    const controller = fakeController({
      open: vi.fn().mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            pending.push(resolve);
          }),
      ),
    });
    const loaders = fakeLoaders();
    const { result, unmount } = renderHook(() =>
      useTerminalSession(controller, SHELL_SPEC, loaders),
    );
    const el = document.createElement("div");

    void result.current.attach(el);
    await waitFor(() => expect(pending).toHaveLength(1));
    void result.current.dispose();
    void result.current.attach(el);
    await waitFor(() => expect(pending).toHaveLength(2));

    pending[0]!("sess-1");
    pending[1]!("sess-2");
    await waitFor(() => expect(controller.close).toHaveBeenCalledWith("sess-1"));
    await waitFor(() => expect(result.current.status).toBe("open"));
    expect(controller.close).not.toHaveBeenCalledWith("sess-2");
    void result.current.dispose();
    await waitFor(() => expect(controller.close).toHaveBeenCalledWith("sess-2"));
    unmount();
  });

  it("closes a PTY that opened even if wiring then fails", async () => {
    const controller = fakeController({
      open: vi.fn().mockResolvedValue("sess-acquired"),
      scrollback: vi.fn().mockRejectedValue("ipc timeout"),
    });
    const loaders = fakeLoaders();

    const { unmount } = renderHook(() => useHarness(controller, loaders));
    await waitFor(() => expect(controller.close).toHaveBeenCalledWith("sess-acquired"));
    unmount();
  });

  it("does not close an attached PTY on a scrollback transport failure", async () => {
    const controller = fakeController({
      scrollback: vi.fn().mockRejectedValue("ipc timeout"),
    });
    const loaders = fakeLoaders();

    const { unmount } = renderHook(() =>
      useHarness(controller, loaders, ATTACHED_SPEC),
    );
    await waitFor(() => expect(controller.scrollback).toHaveBeenCalledWith("sess-attached"));
    expect(controller.close).not.toHaveBeenCalled();
    expect(controller.open).not.toHaveBeenCalled();
    unmount();
  });

  it("disposes the session instead of orphaning it when unmount happens before controller.open resolves", async () => {
    const { controller, resolveOpen } = deferredController();
    const loaders = fakeLoaders();

    const { unmount } = renderHook(() => useHarness(controller, loaders));

    // Flush the microtask queue so `attach` runs past the (fake, already-
    // resolved) module-loader awaits and reaches the still-pending
    // controller.open() call.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // attach() is in flight, blocked on the still-pending controller.open().
    expect(controller.open).toHaveBeenCalledTimes(1);
    expect(controller.close).not.toHaveBeenCalled();

    // Component unmounts before open() ever resolves.
    unmount();

    // The slow "PTY spawn" finally completes, after the component is gone.
    resolveOpen("sess-orphan");
    // Flush the microtask queue so the rest of `attach` runs.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.close).toHaveBeenCalledWith("sess-orphan");
  });
});
