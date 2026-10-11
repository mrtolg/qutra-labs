import { invoke } from "@tauri-apps/api/core";
import { getBridge } from "@/lib/bridge";
import type { NativeScopeAttestation, NativeToolRun } from "@/lib/bridge/types";
import { e2eTools } from "@/lib/e2eTools";

/* Runs a preset of a tool's form (src-tauri/src/tool_forms.rs). The page
   names the form, the preset and the typed values; Rust picks the flags,
   resolves the investigation files to their verified copies and starts the
   run. */

export interface FormRunRequest {
  installationId: string;
  formId: string;
  presetId: string;
  engagementId?: string;
  targetId?: string;
  values: Record<string, string>;
  scope?: NativeScopeAttestation;
}

export interface FormRunStarted {
  run: NativeToolRun;
  /** `tool-output\<name>` when the preset writes a file. */
  outputName?: string | null;
}

const unavailable = () => Promise.reject(new Error("native_tool_execution_unavailable"));

export const toolFormRuns = {
  run(request: FormRunRequest): Promise<FormRunStarted> {
    if (getBridge().mode !== "tauri") {
      const seam = e2eTools();
      return seam?.runForm ? Promise.resolve(seam.runForm(request)) : unavailable();
    }
    return invoke<FormRunStarted>("tool_form_run", { request });
  },
  /** One of a finished run's logs, exactly as the ledger recorded it. */
  output(runId: string, name: "stdout.log" | "stderr.log"): Promise<string> {
    if (getBridge().mode !== "tauri") {
      const seam = e2eTools();
      return seam?.output ? Promise.resolve(seam.output(runId, name)) : unavailable();
    }
    return invoke<string>("tool_run_output", { runId, name });
  },
};
