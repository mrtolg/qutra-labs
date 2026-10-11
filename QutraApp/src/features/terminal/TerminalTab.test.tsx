import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { TerminalTab } from "./TerminalTab";
import { useTerminalTabs, type TerminalTabSpec } from "./terminalTabs";

// jsdom does not implement `matchMedia`; the real `@xterm/xterm` module this
// component loads calls it during `Terminal.open()` regardless of whether
// the underlying `open`/`openTool` call ever runs. Without this, every
// attach fails with a jsdom-environment error before it ever reaches the
// controller, masking the refusal-mapping behavior this file tests.
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

/**
 * The interactive launch route (`terminal_open_tool`) can refuse
 * with the same stable Rust reason codes the gui route does
 * (`tool_identity_changed`, `tool_disabled`, ...) or a dynamic
 * `spawn:<os error>` string. `useTerminalSession` sets `error` to that raw
 * value, so a user launching a swapped tool interactively must not see the
 * literal Rust identifier in the callout. This proves the callout always
 * shows translated copy instead.
 */

function nativeBridge(openTool: ReturnType<typeof vi.fn>): DesktopBridge {
  return {
    mode: "tauri",
    terminal: {
      available: () => true,
      open: vi.fn().mockResolvedValue("sess-1"),
      openTool,
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      closeAll: vi.fn().mockResolvedValue({ requested: 0, failed: [] }),
      onData: vi.fn().mockResolvedValue(() => {}),
      scrollback: vi.fn().mockResolvedValue({ text: "", cursor: 0 }),
      listSessions: vi.fn().mockResolvedValue({ runtimeId: "browser", revision: 0, sessions: [] }),
      onSession: vi.fn().mockResolvedValue(() => {}),
    },
  } as unknown as DesktopBridge;
}

const TOOL_SPEC: TerminalTabSpec = {
  kind: "tool",
  installationId: "installation-1",
  args: ["--target", "example.com"],
};

const SHELL_SPEC: TerminalTabSpec = { kind: "shell", shell: "pwsh" };

function nativeShellBridge(open: ReturnType<typeof vi.fn>): DesktopBridge {
  return {
    mode: "tauri",
    terminal: {
      available: () => true,
      open,
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
  } as unknown as DesktopBridge;
}

afterEach(() => {
  resetBridgeForTesting();
  useTerminalTabs.setState({ tabs: [], activeId: null, reseedAllowed: true });
  vi.restoreAllMocks();
});

describe("TerminalTab session binding", () => {
  it("records the session it opened on its tab, for the Work status strip", async () => {
    setBridgeForTesting(nativeShellBridge(vi.fn().mockResolvedValue("sess-9")));
    const tabId = useTerminalTabs.getState().openShellTab("pwsh", "pwsh.exe");

    render(<TerminalTab tabId={tabId} spec={SHELL_SPEC} active title="pwsh.exe" />);

    // Attaching imports the real xterm module first; under a loaded gate that
    // alone has taken over the default 1 s.
    await waitFor(
      () => expect(useTerminalTabs.getState().tabs[0]!.sessionId).toBe("sess-9"),
      { timeout: 10_000 },
    );
  });
});

describe("TerminalTab failure display", () => {
  it("renders a known refusal reason as translated text, never the raw Rust identifier", async () => {
    const openTool = vi.fn().mockRejectedValue("tool_identity_changed");
    setBridgeForTesting(nativeBridge(openTool));

    render(<TerminalTab tabId="t-test" spec={TOOL_SPEC} active title="Test Tool" />);

    const callout = await screen.findByText(
      "Test Tool's identity changed since it was last verified. Review and trust it before launching.",
    );
    expect(callout).not.toHaveTextContent("tool_identity_changed");
  });

  it("falls back to a generic translated message for an unrecognized reason, never raw", async () => {
    const openTool = vi
      .fn()
      .mockRejectedValue("spawn:No such file or directory (os error 2)");
    setBridgeForTesting(nativeBridge(openTool));

    render(<TerminalTab tabId="t-test" spec={TOOL_SPEC} active title="Test Tool" />);

    const callout = await screen.findByText(
      "Couldn't launch Test Tool. Try again, or check its identity in the tool library.",
    );
    expect(callout).not.toHaveTextContent("spawn:");
  });

  /**
   * Regression: a *shell* tab's PTY failure (`openpty:<os error>`,
   * `spawn:<os error>`) is not a tool-launch refusal -- there is no
   * installation, no tool identity, and no tool-library entry to check.
   * Routing it through `launchFailureMessage` anyway (keyed only on
   * `title`) would give actively wrong advice: a `pwsh`
   * tab whose PTY failed to spawn would tell the user to "check its
   * identity in the tool library," where pwsh does not exist. Shell tabs
   * must surface the raw PTY diagnostic instead.
   */
  it("renders the raw PTY failure reason for a shell tab, not tool-launch advice", async () => {
    const reason = "spawn:The system cannot find the file specified. (os error 2)";
    const open = vi.fn().mockRejectedValue(reason);
    setBridgeForTesting(nativeShellBridge(open));

    render(<TerminalTab tabId="t-test" spec={SHELL_SPEC} active title="pwsh" />);

    const callout = await screen.findByText(reason);
    expect(callout).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Couldn't launch pwsh. Try again, or check its identity in the tool library.",
      ),
    ).not.toBeInTheDocument();
  });

  it("renders session-gone copy for an attached tab whose PTY no longer exists", async () => {
    const scrollback = vi.fn().mockRejectedValue("no such session");
    setBridgeForTesting({
      mode: "tauri",
      terminal: {
        available: () => true,
        open: vi.fn().mockResolvedValue("sess-1"),
        openTool: vi.fn().mockResolvedValue("sess-1"),
        write: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        closeAll: vi.fn().mockResolvedValue({ requested: 0, failed: [] }),
        onData: vi.fn().mockResolvedValue(() => {}),
        scrollback,
      },
    } as unknown as DesktopBridge);

    render(
      <TerminalTab
        tabId="t-test"
        spec={{ kind: "attached", sessionId: "dead-sess" }}
        active
        title="Assistant terminal"
      />,
    );

    expect(
      await screen.findByText(
        "This session is no longer running. Close the tab or open a new terminal.",
      ),
    ).toBeInTheDocument();
  });

  it("renders a transport failure as scrollback-failed copy, not session-gone", async () => {
    const scrollback = vi.fn().mockRejectedValue("ipc timeout");
    setBridgeForTesting({
      mode: "tauri",
      terminal: {
        available: () => true,
        open: vi.fn().mockResolvedValue("sess-1"),
        openTool: vi.fn().mockResolvedValue("sess-1"),
        write: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        closeAll: vi.fn().mockResolvedValue({ requested: 0, failed: [] }),
        onData: vi.fn().mockResolvedValue(() => {}),
        scrollback,
      },
    } as unknown as DesktopBridge);

    render(
      <TerminalTab
        tabId="t-test"
        spec={{ kind: "attached", sessionId: "sess-live" }}
        active
        title="Assistant terminal"
      />,
    );

    expect(
      await screen.findByText(
        "Couldn't read this session's output. The terminal may still be running — retry, or close the tab.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "This session is no longer running. Close the tab or open a new terminal.",
      ),
    ).toBeNull();
  });
});
