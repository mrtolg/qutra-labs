import { describe, expect, it, vi } from "vitest";
import { runNativeDeviceFlow, type NativeDeviceCode } from "./nativeDeviceFlow";

const code: NativeDeviceCode = {
  deviceCode: "temporary-device-code",
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
  expiresInSec: 900,
  intervalSec: 5,
};

describe("native GitHub device flow", () => {
  it("polls at the supplied interval and never receives a token", async () => {
    const invokeImpl = vi
      .fn()
      .mockResolvedValueOnce(code)
      .mockResolvedValueOnce({ state: "pending" })
      .mockResolvedValueOnce({ state: "authorized" });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const states: string[] = [];

    const result = await runNativeDeviceFlow("Iv1.client", {
      invokeImpl,
      sleep,
      onState: (state) => states.push(state.phase),
    });

    expect(result).toEqual({ phase: "authorized" });
    expect(states).toEqual([
      "requesting",
      "awaiting",
      "authorized",
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 5000);
    expect(JSON.stringify(invokeImpl.mock.results)).not.toContain("token");
  });

  it("honors slow_down and cancellation", async () => {
    const signal = { aborted: false };
    const invokeImpl = vi
      .fn()
      .mockResolvedValueOnce(code)
      .mockResolvedValueOnce({ state: "slow_down" });
    const waits: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      waits.push(ms);
      if (waits.length === 2) signal.aborted = true;
    });

    const result = await runNativeDeviceFlow("Iv1.client", {
      invokeImpl,
      sleep,
      signal,
    });

    expect(result).toEqual({ phase: "cancelled" });
    expect(waits).toEqual([5000, 10000]);
  });

  it("maps native failures to stable redacted errors", async () => {
    const result = await runNativeDeviceFlow("bad", {
      invokeImpl: vi.fn().mockRejectedValue("device_flow_disabled"),
    });
    expect(result).toEqual({
      phase: "error",
      detail: "device_flow_disabled",
    });
  });
});
