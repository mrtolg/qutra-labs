import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { TauriBridge } from "./tauriBridge";
import type { LaunchReceipt } from "./types";

// Ugly like production: ids are what the registry and Rust mint, never
// "tool-nmap".
const INSTALL = "tool-3b9f2e71-0c4d-4a8e-9f6b-7d2c1e5a8b30";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function receipt(overrides: Partial<LaunchReceipt>): LaunchReceipt {
  return {
    launchId: "launch-5d2a9c4e-7b1f-4e8a-a3c6-0f9d2b7e1c58",
    operationId: "e4b7c1a9-3f2d-4c6e-8a5b-9d0f1e2c3b47",
    installationId: INSTALL,
    displayName: "Burp Suite Community",
    origin: "manual",
    requestedAt: 1_727_800_000_000,
    spawnedAt: null,
    pid: null,
    outcome: "unknown",
    tracking: "unmanaged",
    reasonCode: null,
    recorded: true,
    ...overrides,
  };
}

afterEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe("TauriBridge launch receipts", () => {
  const supervisor = () => new TauriBridge().toolSupervisor;

  it("sends a fresh operation id with each launch and returns Rust's receipt", async () => {
    const launched = receipt({
      outcome: "launched",
      pid: 4242,
      spawnedAt: 1_727_800_000_050,
    });
    invoke.mockResolvedValue(launched);

    const first = await supervisor().launchDetached(INSTALL, ["--project", "x"]);
    await supervisor().launchDetached(INSTALL, []);

    expect(first).toEqual({ ok: true, receipt: launched });
    const [command, payload] = invoke.mock.calls[0];
    expect(command).toBe("launch_tool_detached");
    expect(payload).toMatchObject({ installationId: INSTALL, args: ["--project", "x"] });
    expect(payload.operationId).toMatch(UUID);
    expect(invoke.mock.calls[1][1].operationId).not.toBe(payload.operationId);
  });

  it("reports a failed receipt with its reason code, never as success", async () => {
    const failed = receipt({ outcome: "failed", reasonCode: "tool_identity_changed" });
    invoke.mockResolvedValue(failed);

    await expect(supervisor().launchDetached(INSTALL, [])).resolves.toEqual({
      ok: false,
      reason: "tool_identity_changed",
      receipt: failed,
    });
  });

  it("reports an outcome Rust could not observe as not launched", async () => {
    const unknown = receipt({ outcome: "unknown", reasonCode: "outcome_not_recorded" });
    invoke.mockResolvedValue(unknown);

    const result = await supervisor().launchDetached(INSTALL, []);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("outcome_not_recorded");
  });

  it("turns a refusal with no attempt into a reason and no receipt", async () => {
    invoke.mockRejectedValue("launch_record_failed");

    await expect(supervisor().launchDetached(INSTALL, [])).resolves.toEqual({
      ok: false,
      reason: "launch_record_failed",
    });
  });

  it("lists recent receipts from Rust", async () => {
    const list = [receipt({ outcome: "launched", pid: 9 })];
    invoke.mockResolvedValue(list);

    await expect(supervisor().listLaunches(20)).resolves.toEqual(list);
    expect(invoke).toHaveBeenCalledWith("tool_launches_list", { limit: 20 });
  });

  it("subscribes to new and updated receipts on tool://launch", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const seen: LaunchReceipt[] = [];

    const stop = await supervisor().onLaunch((r) => seen.push(r));
    const [event, handler] = listen.mock.calls[0];
    expect(event).toBe("tool://launch");
    const pushed = receipt({ outcome: "launched", pid: 1 });
    handler({ payload: pushed });
    expect(seen).toEqual([pushed]);
    expect(stop).toBe(unlisten);
  });
});
