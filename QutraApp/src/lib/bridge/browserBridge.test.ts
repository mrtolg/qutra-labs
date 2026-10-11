import { describe, expect, it, vi } from "vitest";
import { BrowserBridge } from "./browserBridge";
import type { SnapshotItem } from "@/domain/types";
import type { RestoreStepEvent } from "./types";

const item = (id: string, over: Partial<SnapshotItem> = {}): SnapshotItem => ({
  id,
  kind: "app",
  title: id,
  detail: "",
  target: "C:\\apps\\ok.exe",
  selected: true,
  sensitive: false,
  ...over,
});

async function runRestore(items: SnapshotItem[]) {
  vi.useFakeTimers();
  const bridge = new BrowserBridge();
  const events: RestoreStepEvent[] = [];
  bridge.restoreItems(items, (e) => events.push(e));
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  return events;
}

describe("BrowserBridge restore simulation", () => {
  it("reports honest capabilities (simulated, browser_mode)", () => {
    const caps = new BrowserBridge().capabilities();
    expect(caps.runningApps.simulated).toBe(true);
    expect(caps.launchApp.simulated).toBe(true);
    expect(caps.openPath.available).toBe(false);
    expect(caps.pickPath.available).toBe(false);
    expect(caps.secureStore.available).toBe(false);
    expect(caps.toolSupervisor.available).toBe(false);
  });

  it("walks items through launching→…→restored and completes", async () => {
    const events = await runRestore([item("a")]);
    const states = events
      .filter((e): e is Extract<RestoreStepEvent, { kind: "state" }> => e.kind === "state")
      .map((e) => e.state);
    expect(states[0]).toBe("launching");
    expect(states).toContain("waiting");
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
  });

  it("marks missing executables failed and elevated apps permission_required", async () => {
    const events = await runRestore([
      item("m", { target: "C:\\missing\\app.exe" }),
      item("e", { target: "C:\\elevated\\db.exe" }),
    ]);
    const finals = new Map<string, string>();
    for (const e of events) {
      if (e.kind === "state") finals.set(e.itemId, e.state);
    }
    expect(finals.get("m")).toBe("failed");
    expect(finals.get("e")).toBe("permission_required");
    const done = events.find((e) => e.kind === "done");
    expect(done && done.kind === "done" && done.status).toBe("partial");
  });

  it("cancel stops the run and reports cancelled", async () => {
    vi.useFakeTimers();
    const bridge = new BrowserBridge();
    const events: RestoreStepEvent[] = [];
    const { cancel } = bridge.restoreItems([item("a"), item("b")], (e) =>
      events.push(e),
    );
    await vi.advanceTimersByTimeAsync(300);
    cancel();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    const done = events.filter((e) => e.kind === "done");
    expect(done.some((d) => d.kind === "done" && d.status === "cancelled")).toBe(true);
  });

  it("is deterministic for the same item ids", async () => {
    const a = await runRestore([item("same-id")]);
    const b = await runRestore([item("same-id")]);
    expect(a.map((e) => JSON.stringify(e))).toEqual(b.map((e) => JSON.stringify(e)));
  });
});

describe("BrowserBridge previous-renderer abandon", () => {
  it("is a no-op and never fakes a native close", async () => {
    await expect(new BrowserBridge().abandonPreviousRenderer()).resolves.toEqual({
      cancelledTurn: false,
      closedSessions: 0,
    });
  });
});

describe("BrowserBridge native tool boundary", () => {
  it("never simulates native tool registration or execution", async () => {
    const supervisor = new BrowserBridge().toolSupervisor;
    expect(supervisor.available()).toBe(false);
    await expect(
      supervisor.locateCandidate("Locate", "Windows executable"),
    ).rejects.toThrow("native_tool_execution_unavailable");
    await expect(supervisor.listInstallations()).resolves.toEqual([]);
    await expect(supervisor.listRuns()).resolves.toEqual([]);
    await expect(supervisor.deleteArtifacts("run-forged")).rejects.toThrow(
      "native_tool_execution_unavailable",
    );
  });

  it("launchDetached is an honest failure, never a thrown error or a simulated launch", async () => {
    const supervisor = new BrowserBridge().toolSupervisor;
    await expect(
      supervisor.launchDetached("tool-forged", ["--flag"]),
    ).resolves.toEqual({ ok: false, reason: "browser_mode" });
  });

  it("has no launch receipts, because it launched nothing", async () => {
    const supervisor = new BrowserBridge().toolSupervisor;
    await supervisor.launchDetached("tool-forged", []);
    await expect(supervisor.listLaunches(20)).resolves.toEqual([]);
    const listener = vi.fn();
    const stop = await supervisor.onLaunch(listener);
    stop();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("BrowserBridge secure store honesty", () => {
  it("never persists a secret and reports unavailable", async () => {
    const store = new BrowserBridge().secureStore;
    expect(store.available()).toBe(false);
    const set = await store.set("github.token", "ghp_secret");
    expect(set.ok).toBe(false);
    expect(set.reason).toBe("browser_mode");
    expect(await store.has("github.token")).toBe(false);
    // Delete is idempotent/no-op success.
    expect((await store.delete("github.token")).ok).toBe(true);
  });
});
