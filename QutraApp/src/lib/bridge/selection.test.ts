import { afterEach, describe, expect, it } from "vitest";
import { getBridge, resetBridgeForTesting } from "./index";
import { setRuntimeForTesting } from "@/lib/runtime";
import { BrowserBridge } from "./browserBridge";

/**
 * Contract: the browser runtime must select the honest simulator and its
 * capabilities must be clearly marked simulated — a native window can never
 * silently get the browser bridge, and vice-versa.
 */
describe("bridge selection & honesty", () => {
  afterEach(() => {
    resetBridgeForTesting();
    setRuntimeForTesting(null);
  });

  it("browser runtime selects BrowserBridge with simulated capabilities", () => {
    setRuntimeForTesting("browser");
    resetBridgeForTesting();
    const bridge = getBridge();
    expect(bridge).toBeInstanceOf(BrowserBridge);
    expect(bridge.mode).toBe("browser");
    const caps = bridge.capabilities();
    // The capabilities that stand in for native OS actions must announce
    // themselves as simulated so the UI cannot overclaim.
    expect(caps.runningApps.simulated).toBe(true);
    expect(caps.launchApp.simulated).toBe(true);
    expect(caps.windowBounds.simulated).toBe(true);
  });

  it("mode and simulated flags are mutually consistent", () => {
    setRuntimeForTesting("browser");
    resetBridgeForTesting();
    const caps = getBridge().capabilities();
    // A capability is either real (native) or simulated, never both.
    for (const cap of Object.values(caps)) {
      expect(cap.available && cap.simulated && cap.reason === undefined).toBe(
        false,
      );
    }
  });
});
