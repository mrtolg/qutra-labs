import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { setRuntimeForTesting } from "@/lib/runtime";
import {
  abandonPreviousRendererWork,
  installRendererShutdown,
} from "./lifecycle";

afterEach(() => {
  setRuntimeForTesting(null);
  resetBridgeForTesting();
});

describe("abandonPreviousRendererWork", () => {
  it("is a no-op in a browser build", async () => {
    setRuntimeForTesting("browser");
    const abandonPreviousRenderer = vi.fn();
    setBridgeForTesting({
      mode: "browser",
      abandonPreviousRenderer,
    } as unknown as DesktopBridge);

    await expect(abandonPreviousRendererWork()).resolves.toEqual({
      cancelledTurn: false,
      closedSessions: 0,
    });
    expect(abandonPreviousRenderer).not.toHaveBeenCalled();
  });

  it("asks Rust when this is a native renderer", async () => {
    setRuntimeForTesting("tauri");
    const abandonPreviousRenderer = vi
      .fn()
      .mockResolvedValue({ cancelledTurn: true, closedSessions: 2 });
    setBridgeForTesting({
      mode: "tauri",
      abandonPreviousRenderer,
    } as unknown as DesktopBridge);

    await expect(abandonPreviousRendererWork()).resolves.toEqual({
      cancelledTurn: true,
      closedSessions: 2,
    });
    expect(abandonPreviousRenderer).toHaveBeenCalledTimes(1);
  });
});

describe("installRendererShutdown", () => {
  it("reuses abandonPreviousRendererWork on pagehide, and does not invent a second primitive", async () => {
    setRuntimeForTesting("tauri");
    const abandonPreviousRenderer = vi
      .fn()
      .mockResolvedValue({ cancelledTurn: true, closedSessions: 1 });
    setBridgeForTesting({
      mode: "tauri",
      abandonPreviousRenderer,
    } as unknown as DesktopBridge);

    const uninstall = installRendererShutdown();
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(abandonPreviousRenderer).toHaveBeenCalledTimes(1));
    uninstall();
  });
});
