import { invoke } from "@tauri-apps/api/core";
import type { AnalysisRun } from "@/lib/analysis";
import { getBridge } from "@/lib/bridge";
import type { NativeToolRun } from "@/lib/bridge/types";

/* Programs outside Qutra Labs, run on an investigation's files (spec
   2026-10-07 §6.1). Rust owns the table of tools and builds every
   argument list: a call names a tool and a file by id and nothing else
   (src-tauri/src/external_tools/). These commands need Private Lab. */

/** Rust's word for whether a tool can start. */
export type ExternalStatus = "ready" | "not_installed" | "disabled" | "changed" | "needs_consent";

export interface ExternalToolView {
  id: string;
  /** The product's name. */
  name: string;
  /** The launcher item the locate form preselects. */
  catalogId: string;
  /** The category a located program is registered under by default. */
  category: "local" | "network" | "web" | "code" | "dfir";
  /** File kinds it reads; empty for every kind. */
  accepts: string[];
  risk: "read_only";
  execution: "external";
  /** The file names Rust accepts for the program. */
  executables: string[];
  installUrl: string;
  needsRules: boolean;
  status: ExternalStatus;
}

const IN_FLIGHT = new Set(["queued", "starting", "running", "cancelling"]);

/** A ledger run as the run of a step on a file. Only what a step may show
    comes across: the observations (facts Rust already scrubbed) and the
    hashed logs. The run's `argv`, `commandPreview`, tails and folders hold
    the verified copy's local path and stay behind. A failed or blocked run
    keeps Rust's own code in `error` (`blockedReason` first), unchanged, for
    the page to give words to. */
export function toAnalysisRun(run: NativeToolRun): AnalysisRun {
  const live = IN_FLIGHT.has(run.state);
  const finished = run.state === "succeeded";
  return {
    id: run.id,
    kind: "external",
    engagementId: run.engagementId ?? "",
    fileId: run.subject?.fileId ?? "",
    analyzer: run.descriptorId ?? "",
    state: live ? "running" : finished ? "finished" : "failed",
    startedAt: run.startedAt ?? run.createdAt,
    endedAt: run.endedAt ?? run.updatedAt,
    trigger: run.trigger,
    fileSha256: run.subject?.fileSha256 ?? "",
    limited: run.truncated,
    ...(live || finished ? {} : { error: run.blockedReason || run.terminationReason }),
    observations: run.observations,
    outputs: run.outputs,
  };
}

export const externalTools = {
  /** The browser build has no programs to run. */
  available: (): boolean => getBridge().mode === "tauri",
  list: (): Promise<ExternalToolView[]> => invoke("external_tools_list"),
  /** The investigation's runs of these tools, newest first. Needs Private Lab. */
  runs: async (engagementId: string): Promise<AnalysisRun[]> => {
    const runs = await invoke<NativeToolRun[]>("external_tool_runs", { engagementId });
    return runs.filter((run) => run.descriptorId && run.subject?.fileId).map(toAnalysisRun);
  },
  /** Resolves when the run has ended. Rejects with Rust's code, unchanged:
      `tool_not_installed`, `file_changed`, `unknown_rules_file`,
      `rules_too_large`, `rules_include_not_allowed`, `input_too_large`,
      `run_ledger_read_only`, `run_ledger_backup_failed`,
      `tool_identity_changed`, `tool_disabled`, ... A refused start that
      still made a row (a blocked run) resolves, with its reason as `error`. */
  run: async (
    engagementId: string,
    fileId: string,
    tool: string,
    rulesFileId?: string,
  ): Promise<AnalysisRun> =>
    toAnalysisRun(
      await invoke<NativeToolRun>("external_tool_run", { engagementId, fileId, tool, rulesFileId }),
    ),
  /** A log of a run Rust hashed: `stdout.log` or `stderr.log`. Rejects with
      `output_changed` when the log is no longer what the hash says. */
  output: (runId: string, name = "stdout.log"): Promise<string> =>
    invoke("tool_run_output", { runId, name }),
};
