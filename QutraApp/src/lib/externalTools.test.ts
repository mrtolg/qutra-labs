import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeToolRun } from "@/lib/bridge/types";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { externalTools, toAnalysisRun } from "./externalTools";

const native = (overrides: Partial<NativeToolRun> = {}): NativeToolRun => ({
  id: "run-1",
  requestId: "external-1",
  profileId: "external-exiftool",
  installationId: "tool-1",
  engagementId: "eng_1",
  state: "succeeded",
  argv: ["-json"],
  commandPreview: "ExifTool -json",
  terminationReason: "completed",
  workingDir: "",
  artifactDir: "",
  stdoutTail: "",
  stderrTail: "",
  bytesOut: 10,
  bytesErr: 0,
  truncated: false,
  blockedReason: "",
  artifacts: [],
  kind: "external",
  trigger: { by: "user" },
  subject: { fileId: "file_1", fileSha256: "ab" },
  descriptorId: "exiftool",
  outputs: [{ name: "stdout.log", relPath: "runs/run-1/stdout.log", sha256: "cd", bytes: 10 }],
  observations: [{ id: "run-1:0", key: "exiftool.camera", value: "Canon", group: "summary" }],
  createdAt: 1,
  updatedAt: 9,
  startedAt: 2,
  endedAt: 8,
  ...overrides,
});

afterEach(() => invoke.mockReset());

describe("a ledger run as a step's run", () => {
  it("is finished when it succeeded, with its logs and observations", () => {
    expect(toAnalysisRun(native())).toMatchObject({
      id: "run-1",
      kind: "external",
      analyzer: "exiftool",
      fileId: "file_1",
      state: "finished",
      startedAt: 2,
      endedAt: 8,
      fileSha256: "ab",
      trigger: { by: "user" },
      limited: false,
      outputs: [{ name: "stdout.log" }],
      observations: [{ key: "exiftool.camera" }],
    });
    expect(toAnalysisRun(native())).not.toHaveProperty("error");
  });

  it("is running while it is in flight, and failed with Rust's reason otherwise", () => {
    expect(toAnalysisRun(native({ state: "running" })).state).toBe("running");
    expect(toAnalysisRun(native({ state: "failed", terminationReason: "non_zero_exit" }))).toMatchObject({
      state: "failed",
      error: "non_zero_exit",
    });
    expect(
      toAnalysisRun(native({ state: "blocked", blockedReason: "tool_identity_changed", terminationReason: "tool_identity_changed" })).error,
    ).toBe("tool_identity_changed");
    expect(toAnalysisRun(native({ truncated: true })).limited).toBe(true);
  });

  it("carries every blocked reason and every ending through unchanged", () => {
    // The panels give each its copy; this layer must not rename or drop one.
    for (const reason of [
      "tool_identity_changed",
      "tool_disabled",
      "tool_path_missing",
      "concurrency_limit_reached",
      "consent_revoked",
    ]) {
      expect(toAnalysisRun(native({ state: "blocked", blockedReason: reason, terminationReason: "" }))).toMatchObject({
        state: "failed",
        error: reason,
      });
    }
    for (const [state, reason] of [
      ["timed_out", "timeout"],
      ["cancelled", "user_cancelled"],
      ["orphaned", "app_restarted"],
      ["failed", "output_unreadable"],
      ["failed", "spawn_failed"],
    ] as const) {
      expect(toAnalysisRun(native({ state, terminationReason: reason, blockedReason: "" }))).toMatchObject({
        state: "failed",
        error: reason,
      });
    }
  });

  it("keeps the command, the tails and every path out of the run", () => {
    // Rust's rows carry the verified copy's absolute path in these fields.
    const run = toAnalysisRun(
      native({
        argv: ["-json", "C:\\Users\\bob\\AppData\\qutra\\files\\copy-9f.jpg"],
        commandPreview: "ExifTool -json C:\\Users\\bob\\AppData\\qutra\\files\\copy-9f.jpg",
        workingDir: "C:\\Users\\bob\\Tools\\ExifTool",
        artifactDir: "C:\\Users\\bob\\AppData\\qutra\\runs\\run-1",
        stdoutTail: "stdout from C:\\Users\\bob\\AppData\\qutra\\files\\copy-9f.jpg",
        stderrTail: "stderr from C:\\Users\\bob\\AppData\\qutra\\files\\copy-9f.jpg",
      }),
    );
    expect(Object.keys(run).sort()).toEqual(
      [
        "analyzer",
        "endedAt",
        "engagementId",
        "fileId",
        "fileSha256",
        "id",
        "kind",
        "limited",
        "observations",
        "outputs",
        "startedAt",
        "state",
        "trigger",
      ].sort(),
    );
    expect(JSON.stringify(run)).not.toMatch(/bob|AppData|stdout from|stderr from|-json|ExifTool/);
  });
});

describe("the commands", () => {
  it("send only ids, and read a run's log by name", async () => {
    invoke.mockResolvedValueOnce([native(), native({ id: "run-2", descriptorId: undefined })]);
    const runs = await externalTools.runs("eng_1");
    expect(invoke).toHaveBeenCalledWith("external_tool_runs", { engagementId: "eng_1" });
    // A ledger run that no descriptor made is not a step's run.
    expect(runs.map((run) => run.id)).toEqual(["run-1"]);

    invoke.mockResolvedValueOnce(native());
    const run = await externalTools.run("eng_1", "file_1", "yara", "file_rules");
    expect(invoke).toHaveBeenLastCalledWith("external_tool_run", {
      engagementId: "eng_1",
      fileId: "file_1",
      tool: "yara",
      rulesFileId: "file_rules",
    });
    expect(run.analyzer).toBe("exiftool");

    invoke.mockResolvedValueOnce("text");
    await externalTools.output("run-1");
    expect(invoke).toHaveBeenLastCalledWith("tool_run_output", { runId: "run-1", name: "stdout.log" });
  });

  it("lists the tools, and drops a run with no file", async () => {
    invoke.mockResolvedValueOnce([{ id: "exiftool", status: "ready" }]);
    await expect(externalTools.list()).resolves.toEqual([{ id: "exiftool", status: "ready" }]);
    expect(invoke).toHaveBeenCalledWith("external_tools_list");

    invoke.mockResolvedValueOnce([native({ subject: undefined }), native({ id: "run-3", subject: {} })]);
    await expect(externalTools.runs("eng_1")).resolves.toEqual([]);
  });

  it("lets Rust's rejection codes through untouched", async () => {
    // These come back as the call's rejection, for the page to give copy.
    for (const code of [
      "unknown_rules_file",
      "rules_too_large",
      "rules_include_not_allowed",
      "input_too_large",
      "run_ledger_read_only",
      "run_ledger_backup_failed",
      "tool_identity_changed",
      "tool_disabled",
    ]) {
      invoke.mockRejectedValueOnce(code);
      await expect(externalTools.run("eng_1", "file_1", "yara", "file_rules")).rejects.toBe(code);
    }
    invoke.mockRejectedValueOnce("output_changed");
    await expect(externalTools.output("run-1", "stderr.log")).rejects.toBe("output_changed");
    expect(invoke).toHaveBeenLastCalledWith("tool_run_output", { runId: "run-1", name: "stderr.log" });
  });
});
