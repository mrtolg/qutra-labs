import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeLabRuntime, useLabRuntime } from "./labRuntime";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import type {
  NativeToolInstallation,
  NativeToolRun,
} from "@/lib/bridge/types";

/* The mirror of native installations, runs and artifacts into the document
   store (data contracts §8) is diffed and batched: an unchanged
   refresh writes nothing, a changed one writes each affected collection once,
   and a live run's output counters stay in runtime state until its next
   lifecycle transition. Ids are shaped like production's (UUIDs). */

const INSTALL_ID = "3f0c9b1e-6a4d-4c1f-9e0b-2d7a5c8e1f40";
const RUN_ID = "b7e2d4a9-1c3f-4e8a-9d6b-0f5a2c7e3b18";
const OTHER_RUN_ID = "5c9a1e7f-2b4d-4a6c-8e3f-7d1b9a0c4e62";

function installation(
  changes: Partial<NativeToolInstallation> = {},
): NativeToolInstallation {
  return {
    id: INSTALL_ID,
    displayName: "nmap.exe",
    runner: "executable",
    canonicalPath: "C:\\Program Files (x86)\\Nmap\\nmap.exe",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    sizeBytes: 3_142_656,
    version: "7.95",
    publisher: "Insecure.Com LLC",
    signatureState: "valid",
    category: "network",
    riskTier: "medium",
    docUrl: "",
    tags: [],
    workingDir: "C:\\Program Files (x86)\\Nmap",
    enabled: true,
    changedSinceVerify: false,
    createdAt: 1_727_800_000_000,
    updatedAt: 1_727_800_000_000,
    lastVerifiedAt: 1_727_800_000_000,
    ...changes,
  };
}

function run(changes: Partial<NativeToolRun> = {}): NativeToolRun {
  return {
    id: RUN_ID,
    requestId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
    profileId: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
    installationId: INSTALL_ID,
    state: "running",
    argv: ["-sV", "127.0.0.1"],
    commandPreview: "nmap.exe -sV 127.0.0.1",
    pid: 18_244,
    startedAt: 1_727_800_100_000,
    terminationReason: "",
    workingDir: "C:\\Program Files (x86)\\Nmap",
    artifactDir: `C:\\Users\\samil\\AppData\\Roaming\\com.contextos.app\\runs\\${RUN_ID}`,
    stdoutTail: "Starting Nmap 7.95\r\n",
    stderrTail: "",
    bytesOut: 20,
    bytesErr: 0,
    truncated: false,
    blockedReason: "",
    kind: "external",
    trigger: { by: "user" },
    outputs: [],
    observations: [],
    artifacts: [
      {
        kind: "stdout",
        path: `C:\\Users\\samil\\AppData\\Roaming\\com.contextos.app\\runs\\${RUN_ID}\\stdout.log`,
        sizeBytes: 20,
        truncated: false,
      },
    ],
    createdAt: 1_727_800_099_000,
    updatedAt: 1_727_800_100_000,
    ...changes,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A store whose durable writes are recorded by collection. */
function store() {
  const adapter = new MemoryStorageAdapter();
  const db = new Database(adapter);
  setDbForTesting(db);
  const written: string[][] = [];
  const original = adapter.writeBatchDurable.bind(adapter);
  adapter.writeBatchDurable = (changes) => {
    written.push(Object.keys(changes));
    return original(changes);
  };
  return { adapter, db, written };
}

function supervisor(
  read: () => { installations: NativeToolInstallation[]; runs: NativeToolRun[] },
) {
  setBridgeForTesting({
    mode: "tauri",
    toolSupervisor: {
      available: () => true,
      listInstallations: () => Promise.resolve(read().installations),
      listRuns: () => Promise.resolve(read().runs),
    },
  } as unknown as DesktopBridge);
}

afterEach(() => {
  disposeLabRuntime();
  setDbForTesting(null);
  resetBridgeForTesting();
  vi.restoreAllMocks();
});

describe("lab runtime mirror", () => {
  it("writes each affected collection once, and nothing when nothing changed", async () => {
    const { db, written } = store();
    const snapshot = {
      installations: [installation()],
      runs: [
        run({ state: "succeeded", endedAt: 1_727_800_200_000, exitCode: 0 }),
        run({
          id: OTHER_RUN_ID,
          state: "failed",
          endedAt: 1_727_800_300_000,
          exitCode: 1,
          artifacts: [],
        }),
      ],
    };
    supervisor(() => snapshot);

    await useLabRuntime.getState().refresh();
    expect(written.flat().sort()).toEqual([
      "artifacts",
      "toolInstallations",
      "toolRuns",
    ]);
    expect(db.collection("toolRuns").getAll()).toHaveLength(2);

    written.length = 0;
    await useLabRuntime.getState().refresh();
    await useLabRuntime.getState().refresh();
    expect(written).toEqual([]);
  });

  it("keeps a live run's output out of the store until its next transition", async () => {
    const { db, written } = store();
    let current = run();
    supervisor(() => ({ installations: [installation()], runs: [current] }));

    await useLabRuntime.getState().refresh();
    written.length = 0;

    // Output arrives: the tail, the byte counters, the artifact size and
    // updatedAt move. The runtime shows it; the store does not change.
    current = run({
      stdoutTail: "Starting Nmap 7.95\r\nPORT   STATE SERVICE\r\n",
      bytesOut: 44,
      updatedAt: 1_727_800_150_000,
      artifacts: [{ ...run().artifacts[0], sizeBytes: 44 }],
    });
    await useLabRuntime.getState().refresh();
    expect(written).toEqual([]);
    expect(useLabRuntime.getState().runs[0].bytesOut).toBe(44);
    expect(db.collection("toolRuns").get(RUN_ID)?.bytesOut).toBe(20);

    // The run ends: the final summary is written, once.
    current = run({
      state: "succeeded",
      exitCode: 0,
      endedAt: 1_727_800_200_000,
      stdoutTail: "Starting Nmap 7.95\r\nPORT   STATE SERVICE\r\nNmap done\r\n",
      bytesOut: 55,
      updatedAt: 1_727_800_200_000,
      artifacts: [{ ...run().artifacts[0], sizeBytes: 55 }],
    });
    await useLabRuntime.getState().refresh();
    expect(written.filter((keys) => keys.includes("toolRuns"))).toHaveLength(1);
    const stored = db.collection("toolRuns").get(RUN_ID);
    expect(stored?.state).toBe("succeeded");
    expect(stored?.bytesOut).toBe(55);
    expect(stored?.stdoutTail).toContain("Nmap done");
    expect(db.collection("artifacts").get(`${RUN_ID}-stdout`)?.sizeBytes).toBe(55);
  });

  it("writes a live run's lifecycle change even when its output did not move", async () => {
    const { db, written } = store();
    let current = run({ state: "starting", pid: undefined });
    supervisor(() => ({ installations: [], runs: [current] }));

    await useLabRuntime.getState().refresh();
    written.length = 0;
    current = run();
    await useLabRuntime.getState().refresh();

    expect(written).toEqual([["toolRuns"]]);
    expect(db.collection("toolRuns").get(RUN_ID)?.state).toBe("running");
    expect(db.collection("toolRuns").get(RUN_ID)?.pid).toBe(18_244);
  });

  it("discards a mirror batch still queued when Lab consent is withdrawn", async () => {
    const { adapter, db } = store();
    let current = installation();
    supervisor(() => ({ installations: [current], runs: [] }));
    const disk = deferred<void>();
    adapter.flush = () => disk.promise;

    const first = useLabRuntime.getState().refresh();
    await nextTask();
    current = installation({ enabled: false, updatedAt: 1_727_800_500_000 });
    const second = useLabRuntime.getState().refresh();
    await nextTask();

    useLabRuntime.getState().revoke();
    disk.resolve();
    await Promise.all([first, second]);

    expect(db.collection("toolInstallations").get(INSTALL_ID)?.enabled).toBe(true);
  });

  it("ignores an older read that lands after a newer one", async () => {
    const { db } = store();
    const reads: ReturnType<typeof deferred<NativeToolRun[]>>[] = [];
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: {
        available: () => true,
        listInstallations: () => Promise.resolve([]),
        listRuns: () => {
          const read = deferred<NativeToolRun[]>();
          reads.push(read);
          return read.promise;
        },
      },
    } as unknown as DesktopBridge);

    const older = useLabRuntime.getState().refresh();
    const newer = useLabRuntime.getState().refresh();
    reads[1].resolve([
      run({ state: "succeeded", exitCode: 0, endedAt: 1_727_800_200_000 }),
    ]);
    await newer;
    reads[0].resolve([run()]);
    await older;

    expect(useLabRuntime.getState().runs[0].state).toBe("succeeded");
    expect(db.collection("toolRuns").get(RUN_ID)?.state).toBe("succeeded");
  });

  it("deletes nothing from the store when a read fails", async () => {
    const { db } = store();
    let fail = false;
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: {
        available: () => true,
        listInstallations: () => Promise.resolve([installation()]),
        listRuns: () =>
          fail
            ? Promise.reject(new Error("registry_lock_failed"))
            : Promise.resolve([run({ state: "succeeded", exitCode: 0 })]),
      },
    } as unknown as DesktopBridge);

    await useLabRuntime.getState().refresh();
    fail = true;
    await useLabRuntime.getState().refresh();

    expect(useLabRuntime.getState().readFailed).toBe(true);
    expect(db.collection("toolRuns").getAll()).toHaveLength(1);
    expect(db.collection("toolInstallations").getAll()).toHaveLength(1);
  });

  it("keeps the live state when the mirror cannot be written", async () => {
    const { adapter } = store();
    supervisor(() => ({ installations: [installation()], runs: [run()] }));
    adapter.flush = () => Promise.reject(new Error("SQLITE_FULL"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await useLabRuntime.getState().refresh();

    expect(useLabRuntime.getState().runs).toHaveLength(1);
    expect(useLabRuntime.getState().readFailed).toBe(false);
    expect(logged).toHaveBeenCalled();
  });
});
