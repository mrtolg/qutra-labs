import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { useUi } from "@/state/ui";
import { useTerminalTabs } from "./terminalTabs";
import { closeManagedTerminals } from "./managedTerminals";

afterEach(() => {
  resetBridgeForTesting();
  useTerminalTabs.setState({ tabs: [], activeId: null, reseedAllowed: true });
  useUi.setState({ toasts: [] });
});

function nativeTerminal(closeAll: ReturnType<typeof vi.fn>) {
  setBridgeForTesting({
    mode: "tauri",
    terminal: { available: () => true, closeAll },
  } as unknown as DesktopBridge);
}

describe("closeManagedTerminals", () => {
  it("invalidates tab records and closeAll even when no Terminal view mounted", async () => {
    useTerminalTabs.getState().openAttachedTab({
      sessionId: "sess-before-visit",
      title: "Assistant terminal",
    });
    const closeAll = vi.fn().mockResolvedValue({ requested: 1, failed: [] });
    setBridgeForTesting({
      mode: "tauri",
      terminal: {
        available: () => true,
        closeAll,
      },
    } as unknown as DesktopBridge);

    await closeManagedTerminals();

    expect(useTerminalTabs.getState().tabs).toHaveLength(0);
    expect(useTerminalTabs.getState().reseedAllowed).toBe(false);
    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  it("does not fake a native close in a browser build", async () => {
    useTerminalTabs.getState().openShellTab("pwsh");
    const closeAll = vi.fn();
    setBridgeForTesting({
      mode: "browser",
      terminal: {
        available: () => false,
        closeAll,
      },
    } as unknown as DesktopBridge);

    await closeManagedTerminals();

    expect(useTerminalTabs.getState().tabs).toHaveLength(0);
    expect(closeAll).not.toHaveBeenCalled();
  });

  it("says so when a session would not stop, and returns which", async () => {
    const failed = [{ sessionId: "c1f7a2d4-9e3b-4a85-b6d0-2e8f5a7c1b93", error: "stop_not_confirmed" }];
    nativeTerminal(vi.fn().mockResolvedValue({ requested: 2, failed }));

    const report = await closeManagedTerminals();

    expect(report?.failed).toEqual(failed);
    expect(useUi.getState().toasts).toEqual([
      expect.objectContaining({ kind: "danger", messageKey: "terminal.stopFailed", params: { count: 1 } }),
    ]);
  });

  it("stays quiet when every session stopped", async () => {
    nativeTerminal(vi.fn().mockResolvedValue({ requested: 2, failed: [] }));
    await closeManagedTerminals();
    expect(useUi.getState().toasts).toEqual([]);
  });

  it("says so when Stop all itself fails, without an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    nativeTerminal(vi.fn().mockRejectedValue(new Error("ipc closed")));

    await expect(closeManagedTerminals()).resolves.toBeNull();

    expect(useUi.getState().toasts).toEqual([
      expect.objectContaining({ kind: "danger", messageKey: "terminal.stopAllFailed" }),
    ]);
    warn.mockRestore();
  });

  it("treats a reply without a failure list as Stop all not finishing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    nativeTerminal(vi.fn().mockResolvedValue(2));

    await expect(closeManagedTerminals()).resolves.toBeNull();

    expect(useUi.getState().toasts).toEqual([
      expect.objectContaining({ kind: "danger", messageKey: "terminal.stopAllFailed" }),
    ]);
    warn.mockRestore();
  });
});
