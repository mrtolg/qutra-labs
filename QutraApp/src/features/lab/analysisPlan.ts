import type { AnalysisRun } from "@/lib/analysis";
import type { ExternalStatus } from "@/lib/externalTools";
import type { InvestigationFile } from "@/lib/investigationFiles";

/* The suggested analysis of a file (spec 2026-10-07 §6.3): steps per kind,
   in order, built-in analyses and programs outside Qutra Labs.
   Suggested steps run with "Önerilenleri çalıştır"; optional ones on
   request. A kind this table does not know is treated as an unknown
   binary. */

interface Plan {
  suggested: readonly string[];
  optional: readonly string[];
}

// A step Rust does not offer for the kind is left out (`pe` reads Windows
// programs only, `image` JPEG and PNG only, `capinfos` captures only).
const PROGRAM: Plan = {
  suggested: ["identify", "pe", "strings", "entropy", "signatures", "yara"],
  optional: ["exiftool"],
};
const PICTURE: Plan = {
  suggested: ["identify", "image", "exiftool", "signatures"],
  optional: ["strings", "entropy", "yara"],
};
const OFFICE: Plan = {
  suggested: ["identify", "signatures", "exiftool"],
  optional: ["entropy", "strings", "yara"],
};
const ARCHIVE: Plan = {
  suggested: ["identify", "signatures"],
  optional: ["entropy", "strings", "exiftool", "yara"],
};
const CAPTURE: Plan = {
  suggested: ["identify", "capinfos"],
  optional: ["strings", "entropy", "signatures"],
};
const RECORD: Plan = { suggested: ["identify"], optional: ["strings", "entropy", "signatures"] };

const PLANS: Record<string, Plan> = {
  pe: PROGRAM,
  elf: PROGRAM,
  macho: PROGRAM,
  lnk: PROGRAM,
  binary: PROGRAM,
  text: { suggested: ["identify", "strings"], optional: ["entropy", "signatures", "yara"] },
  jpeg: PICTURE,
  png: PICTURE,
  gif: PICTURE,
  pdf: { suggested: ["identify", "signatures", "exiftool", "strings"], optional: ["entropy", "yara"] },
  office: OFFICE,
  zip: ARCHIVE,
  gzip: ARCHIVE,
  "7z": ARCHIVE,
  rar: ARCHIVE,
  pcap: CAPTURE,
  pcapng: CAPTURE,
  evtx: RECORD,
  sqlite: RECORD,
};

export type StepState =
  | "done"
  | "failed"
  | "queued"
  | "optional"
  | "running"
  /** An outside program that is not registered: "Kur". */
  | "install"
  /** Private Lab is off. */
  | "consent"
  /** YARA has no rules file in the investigation. */
  | "rules"
  /** The program is turned off or changed since it was added. */
  | "check";

/** A step Rust offers: a built-in analyzer, or an outside program with
    whether it can start now. */
export interface StepOffer {
  id: string;
  accepts: readonly string[];
  external?: { status: ExternalStatus; needsRules: boolean };
}

export interface Step {
  analyzer: string;
  state: StepState;
  suggested: boolean;
  /** The step can be started now (an outside program must be ready). */
  canRun: boolean;
  external?: StepOffer["external"];
  /** The newest run of this analyzer on the file. */
  run?: AnalysisRun;
}

/** A rules file for YARA: a text file named .yar or .yara. */
export function isRulesFile(file: Pick<InvestigationFile, "kind" | "originalName">): boolean {
  return file.kind === "text" && /\.(yar|yara)$/i.test(file.originalName);
}

/** The newest run of each analyzer on one file. */
export function latestRuns(runs: readonly AnalysisRun[], fileId: string): Map<string, AnalysisRun> {
  const latest = new Map<string, AnalysisRun>();
  for (const run of runs) {
    if (run.fileId !== fileId) continue;
    const known = latest.get(run.analyzer);
    if (!known || run.startedAt > known.startedAt) latest.set(run.analyzer, run);
  }
  return latest;
}

/** The file's steps in order, each with its state. Steps Rust does not offer
    for this kind are left out. `rulesReady`: the investigation has a rules
    file for YARA. */
export function planSteps(
  kind: string,
  offered: readonly StepOffer[],
  runs: readonly AnalysisRun[],
  fileId: string,
  running: string | null,
  rulesReady = true,
): Step[] {
  const plan = PLANS[kind] ?? PROGRAM;
  const latest = latestRuns(runs, fileId);
  const offer = (id: string) =>
    offered.find((a) => a.id === id && (a.accepts.length === 0 || a.accepts.includes(kind)));
  const steps: Step[] = [];
  for (const [ids, suggested] of [
    [plan.suggested, true],
    [plan.optional, false],
  ] as const) {
    for (const analyzer of ids) {
      const found = offer(analyzer);
      if (!found) continue;
      const run = latest.get(analyzer);
      const external = found.external;
      const canRun =
        !external || (external.status === "ready" && (!external.needsRules || rulesReady));
      const state: StepState =
        running === analyzer || run?.state === "running"
          ? "running"
          : run?.state === "finished"
            ? "done"
            : run?.state === "failed"
              ? "failed"
              : external?.status === "needs_consent"
                ? "consent"
                : external?.status === "not_installed"
                  ? "install"
                  : external?.status === "disabled" || external?.status === "changed"
                    ? "check"
                    : external?.needsRules && !rulesReady
                      ? "rules"
                      : suggested
                        ? "queued"
                        : "optional";
      steps.push({
        analyzer,
        state,
        suggested,
        canRun,
        ...(external ? { external } : {}),
        ...(run ? { run } : {}),
      });
    }
  }
  return steps;
}

/** What "Önerilenleri çalıştır" runs: suggested steps not run yet. */
export function suggestedToRun(steps: readonly Step[]): Step[] {
  return steps.filter((step) => step.suggested && step.state === "queued");
}
