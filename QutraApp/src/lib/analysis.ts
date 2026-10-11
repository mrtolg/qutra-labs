import { invoke } from "@tauri-apps/api/core";
import { getBridge } from "@/lib/bridge";

/* Built-in analysis (spec 2026-10-07 §6.2). Rust reads the
   investigation's copy of a file after checking its SHA-256 again, keeps
   each analysis as a `builtin` run with its observations, and writes a raw
   text output (src-tauri/src/analysis/). Nothing here names a path. */

export type ObservationGroup = "summary" | "interesting" | "detail";

export interface Observation {
  /** `<run id>:<n>` */
  id: string;
  /** What it is: "entropy.file", "strings.urls", ... */
  key: string;
  value: string | number;
  group: ObservationGroup;
  /** Why it stands out: "packed", "embeddedExecutable", ... */
  hint?: string;
  /** Examples: addresses, offsets. */
  items?: string[];
}

export interface AnalysisRun {
  id: string;
  /** A built-in analysis (`ana-`), or a program outside Qutra Labs (`run-`). */
  kind: "builtin" | "external";
  engagementId: string;
  fileId: string;
  analyzer: string;
  /** `running` only for an outside program still going. */
  state: "finished" | "failed" | "running";
  startedAt: number;
  endedAt: number;
  trigger: { by: string; approvalId?: string; conversationId?: string };
  /** The copy's SHA-256, checked again before the run read it. */
  fileSha256: string;
  /** A size cap or the time budget stopped it before the end. */
  limited: boolean;
  /** Why a failed run failed: `read_failed`, `analyzer_failed`, or Rust's reason for a tool. */
  error?: string;
  observations: Observation[];
  outputs: { name: string; relPath: string; sha256: string; bytes: number }[];
}

export interface AnalyzerDescriptor {
  id: string;
  category: string;
  /** File kinds it reads; empty for every kind. */
  accepts: string[];
  risk: "read_only";
  execution: "builtin";
}

export const analysis = {
  /** The browser build has no files to analyse. */
  available: (): boolean => getBridge().mode === "tauri",
  analyzers: (): Promise<AnalyzerDescriptor[]> => invoke("analysis_analyzers"),
  list: (engagementId: string): Promise<AnalysisRun[]> => invoke("analysis_list", { engagementId }),
  /** Rejects with a code: `busy`, `file_changed`, `file_missing`, ... */
  run: (engagementId: string, fileId: string, analyzer: string): Promise<AnalysisRun> =>
    invoke("analysis_run", { engagementId, fileId, analyzer }),
  output: (runId: string): Promise<string> => invoke("analysis_output", { runId }),
};
