import { describe, expect, it, vi } from "vitest";
import {
  parsePollResponse,
  parseDeviceCode,
  runDeviceFlow,
  type DeviceFlowState,
} from "./deviceFlow";

const jsonRes = (obj: unknown): Response =>
  ({ json: async () => obj }) as unknown as Response;

describe("parsePollResponse", () => {
  it("classifies every documented outcome and only exposes the token when authorized", () => {
    expect(parsePollResponse({ access_token: "ghu_x", scope: "repo" })).toEqual({
      kind: "authorized",
      token: "ghu_x",
      scope: "repo",
    });
    expect(parsePollResponse({ error: "authorization_pending" }).kind).toBe("pending");
    expect(parsePollResponse({ error: "slow_down" }).kind).toBe("slow_down");
    expect(parsePollResponse({ error: "access_denied" }).kind).toBe("denied");
    expect(parsePollResponse({ error: "expired_token" }).kind).toBe("expired");
    expect(parsePollResponse({ error: "weird" })).toEqual({ kind: "error", detail: "weird" });
  });
});

describe("parseDeviceCode", () => {
  it("rejects malformed responses and fills defaults", () => {
    expect(parseDeviceCode({})).toBeNull();
    const code = parseDeviceCode({ device_code: "d", user_code: "ABCD-1234" });
    expect(code).toMatchObject({ deviceCode: "d", userCode: "ABCD-1234", intervalSec: 5 });
  });
});

describe("runDeviceFlow", () => {
  const sleep = () => Promise.resolve();

  it("polls until authorized and honors slow_down", async () => {
    const responses = [
      jsonRes({ device_code: "dev", user_code: "AAAA-1111", interval: 5, expires_in: 900 }),
      jsonRes({ error: "authorization_pending" }),
      jsonRes({ error: "slow_down" }),
      jsonRes({ access_token: "ghu_secret", scope: "repo read:user" }),
    ];
    let i = 0;
    const fetchImpl = vi.fn(async () => responses[i++]);
    const states: DeviceFlowState[] = [];

    const final = await runDeviceFlow({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      clientId: "Iv1.test",
      scope: "repo read:user",
      onState: (s) => states.push(s),
    });

    expect(final).toEqual({ phase: "authorized", token: "ghu_secret", scope: "repo read:user" });
    expect(states.map((s) => s.phase)).toEqual(["requesting", "awaiting", "authorized"]);
    // device-code request + 3 token polls
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("stops when cancelled and reports cancelled", async () => {
    const signal = { aborted: false };
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("device/code")) {
        return jsonRes({ device_code: "dev", user_code: "X", interval: 5, expires_in: 900 });
      }
      signal.aborted = true; // user cancels during the first poll
      return jsonRes({ error: "authorization_pending" });
    });
    const final = await runDeviceFlow({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      clientId: "Iv1.test",
      scope: "repo",
      signal,
    });
    expect(final.phase).toBe("cancelled");
  });

  it("surfaces denial honestly", async () => {
    const responses = [
      jsonRes({ device_code: "dev", user_code: "X", interval: 5, expires_in: 900 }),
      jsonRes({ error: "access_denied" }),
    ];
    let i = 0;
    const final = await runDeviceFlow({
      fetchImpl: (async () => responses[i++]) as unknown as typeof fetch,
      sleep,
      clientId: "Iv1.test",
      scope: "repo",
    });
    expect(final.phase).toBe("denied");
  });
});
