import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disposeLabRuntime, useLabRuntime } from "./labRuntime";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import type { NativeToolInstallation } from "@/lib/bridge/types";

beforeEach(() => {
  useLabRuntime.setState({ logs: {}, clearedLogs: {}, selectedRunId: null });
});

describe("lab runtime output view state", () => {
  it("keeps a cleared persisted tail suppressed until new output arrives", () => {
    useLabRuntime.setState({
      logs: {
        "run-1": [{ at: 1, stream: "stdout", text: "line" }],
      },
    });

    useLabRuntime.getState().clearLog("run-1");

    expect(useLabRuntime.getState().logs["run-1"]).toEqual([]);
    expect(useLabRuntime.getState().clearedLogs["run-1"]).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function installation(id = "inst-1"): NativeToolInstallation {
  return {
    id,
    displayName: id,
    runner: "executable",
    canonicalPath: "C:\\tools\\a.exe",
    sha256: "abc",
    sizeBytes: 1,
    version: "1",
    publisher: "",
    signatureState: "unsigned",
    category: "local",
    riskTier: "info",
    docUrl: "",
    tags: [],
    workingDir: "C:\\tools",
    enabled: true,
    changedSinceVerify: false,
    createdAt: 1,
    updatedAt: 1,
    lastVerifiedAt: 1,
  };
}

describe("lab runtime generation guard", () => {
  afterEach(() => {
    disposeLabRuntime();
    setDbForTesting(null);
    resetBridgeForTesting();
  });

  it("drops an in-flight refresh so it neither sets state nor mirrors", async () => {
    const db = new Database(new MemoryStorageAdapter());
    setDbForTesting(db);
    const installations = deferred<NativeToolInstallation[]>();
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: {
        available: () => true,
        listInstallations: () => installations.promise,
        listRuns: () => Promise.resolve([]),
      },
    } as unknown as DesktopBridge);

    const pending = useLabRuntime.getState().refresh();
    useLabRuntime.getState().revoke();
    installations.resolve([installation()]);
    await pending;

    expect(useLabRuntime.getState().installations).toEqual([]);
    expect(useLabRuntime.getState().subscribed).toBe(false);
    expect(useLabRuntime.getState().generation).toBeGreaterThan(0);
    expect(db.collection("toolInstallations").getAll()).toEqual([]);
  });

  it("closes a late listen() immediately and ignores its events", async () => {
    const listen = deferred<() => void>();
    const cleanup = vi.fn();
    let handler: ((event: { kind: string; runId: string; chunk?: string; at: number }) => void) | undefined;
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: {
        available: () => true,
        listInstallations: () => Promise.resolve([]),
        listRuns: () => Promise.resolve([]),
        onEvent: (next: typeof handler) => {
          handler = next;
          return listen.promise;
        },
      },
    } as unknown as DesktopBridge);

    useLabRuntime.getState().ensureSubscribed();
    useLabRuntime.getState().revoke();
    listen.resolve(cleanup);
    await listen.promise;
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalled();
    expect(useLabRuntime.getState().subscribed).toBe(false);

    handler?.({ kind: "stdout", runId: "run-1", chunk: "late\n", at: 1 });
    expect(useLabRuntime.getState().logs["run-1"]).toBeUndefined();
  });
});


/* Home must tell a failed read of the native runs from a
   read that found none. `error` is shared with launch failures, so the read
   has its own flag, set on failure and cleared by the next good read. */
describe("lab runtime read failure", () => {
  afterEach(() => {
    disposeLabRuntime();
    setDbForTesting(null);
    resetBridgeForTesting();
  });

  it("marks a failed list read and clears it on the next good one", async () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    let fail = true;
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: {
        available: () => true,
        listInstallations: () =>
          fail ? Promise.reject(new Error("lock poisoned")) : Promise.resolve([]),
        listRuns: () => Promise.resolve([]),
      },
    } as unknown as DesktopBridge);

    await useLabRuntime.getState().refresh();
    expect(useLabRuntime.getState().readFailed).toBe(true);
    expect(useLabRuntime.getState().ready).toBe(true);

    fail = false;
    await useLabRuntime.getState().refresh();
    expect(useLabRuntime.getState().readFailed).toBe(false);
  });

  it("marks a failed run list read too", async () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: {
        available: () => true,
        listInstallations: () => Promise.resolve([]),
        listRuns: () => Promise.reject(new Error("consent_required")),
      },
    } as unknown as DesktopBridge);

    await useLabRuntime.getState().refresh();
    expect(useLabRuntime.getState().readFailed).toBe(true);
    expect(useLabRuntime.getState().runs).toEqual([]);
  });
});
