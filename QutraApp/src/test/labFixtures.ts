import { getDb } from "@/lib/db/database";
import { useLabRuntime } from "@/state/labRuntime";
import type { NativeToolInstallation, NativeToolRun } from "@/lib/bridge/types";

/* Native Lab records for component tests. Ids are shaped like production
   (UUIDs); nothing here is shown to a user. */

export const NMAP = "7f3c2a9e-51d4-4c1b-9a0e-2d6b8f4e1c37";
const T = 1_759_300_000_000;

export function installation(id: string, displayName: string): NativeToolInstallation {
  return {
    id,
    displayName,
    runner: "executable",
    canonicalPath: `C:\\Tools\\${displayName}\\${displayName.toLowerCase()}.exe`,
    sha256: "b".repeat(64),
    sizeBytes: 1,
    version: "1",
    publisher: "",
    signatureState: "valid",
    category: "network",
    riskTier: "medium",
    docUrl: "",
    tags: [],
    workingDir: "",
    enabled: true,
    changedSinceVerify: false,
    createdAt: 1,
    updatedAt: 1,
    lastVerifiedAt: 1,
  };
}

export function run(overrides: Partial<NativeToolRun>): NativeToolRun {
  return {
    id: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    profileId: crypto.randomUUID(),
    installationId: NMAP,
    state: "succeeded",
    argv: [],
    commandPreview: "",
    terminationReason: "",
    workingDir: "",
    artifactDir: "",
    stdoutTail: "",
    stderrTail: "",
    bytesOut: 0,
    bytesErr: 0,
    truncated: false,
    blockedReason: "",
    kind: "external",
    trigger: { by: "user" },
    outputs: [],
    observations: [],
    artifacts: [],
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

/** A consented, ready native runtime holding these runs. */
export function seedRuntime(runs: NativeToolRun[], selectedRunId: string | null = null) {
  getDb().prefs.set({ privateToolsEnabled: true });
  useLabRuntime.setState({
    available: true,
    ready: true,
    readFailed: false,
    subscribed: true,
    installations: [installation(NMAP, "Nmap")],
    runs,
    outsideLive: [],
    logs: {},
    clearedLogs: {},
    selectedRunId,
    error: "",
  });
}

export function resetRuntime() {
  useLabRuntime.setState({
    available: false,
    ready: false,
    readFailed: false,
    subscribed: false,
    installations: [],
    runs: [],
    outsideLive: [],
    logs: {},
    clearedLogs: {},
    selectedRunId: null,
    error: "",
  });
}
