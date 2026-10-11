import { EvidenceSchema, type Evidence, type Finding } from "@/domain/findings";
import { EVIDENCE_TEXT_LIMIT } from "@/domain/lab/evidenceOps";
import { manualFinding } from "@/domain/lab/findingsOps";
import type { AnalysisRun, Observation } from "@/lib/analysis";
import { sha256Hex } from "@/lib/hash";
import { createId } from "@/lib/id";

/* What a built-in analysis found, kept as evidence (spec
   2026-10-07 §4.5, D6). The evidence names its run and the observations it
   pins, and keeps the run's raw output reference with its SHA-256, so the
   chain finding → evidence → run → raw output can be checked again. Lab-only:
   nothing here enters the first-paint bundle. */

/** What could point at a person. Its value stays out of titles, and a
    report leaves its content out (`sensitivity: "sensitive"`). */
const SENSITIVE = new Set([
  "image.gps",
  "image.owner",
  "image.serial",
  "exiftool.gps",
  "exiftool.owner",
  "exiftool.serial",
]);

/** A built-in step is `analysis:<id>`; a program outside Qutra Labs `tool:<id>`. */
const sourceOf = (run: AnalysisRun) => `${run.kind === "external" ? "tool" : "analysis"}:${run.analyzer}`;

/** The evidence that points at a run's logs: deleting them breaks its link. */
export function evidencePointingAtRun(evidence: readonly Evidence[], runId: string): Evidence[] {
  return evidence.filter((item) => item.kind === "observation" && item.runId === runId);
}

export interface ObservationPin {
  run: AnalysisRun;
  observation: Observation;
  /** The observation's label as the page shows it. */
  label: string;
  /** Its value as the page shows it. */
  shown: string;
  /** Why it stands out, as the page says it. */
  hint?: string;
  now: number;
  findingId?: string;
}

/** Whether an observation's value could point at a person. */
export function isSensitiveObservation(key: string): boolean {
  return SENSITIVE.has(key);
}

/** The title of a pinned observation: the label alone for a sensitive one. */
export function observationTitle(observation: Observation, label: string, shown: string): string {
  return (SENSITIVE.has(observation.key) ? label : `${label}: ${shown}`).slice(0, 120);
}

export async function evidenceFromObservation(pin: ObservationPin): Promise<Evidence> {
  const { run, observation } = pin;
  // The page's wording first, then the exact value Rust reported: the page
  // rounds numbers and turns codes into words.
  const content = [
    `${pin.label}: ${pin.shown}`,
    ...(pin.hint ? [pin.hint] : []),
    `${observation.key} = ${String(observation.value)}`,
    ...(observation.items ?? []).map((item) => `- ${item}`),
  ]
    .join("\n")
    .slice(0, EVIDENCE_TEXT_LIMIT);
  const output = run.outputs[0];
  return EvidenceSchema.parse({
    id: createId("ev"),
    findingId: pin.findingId,
    engagementId: run.engagementId,
    runId: run.id,
    fileId: run.fileId,
    kind: "observation",
    title: observationTitle(observation, pin.label, pin.shown),
    content,
    path: "",
    sha256: await sha256Hex(content),
    capturedAt: pin.now,
    source: sourceOf(run),
    sensitivity: SENSITIVE.has(observation.key) ? "sensitive" : "normal",
    includeInReport: true,
    demo: false,
    createdAt: pin.now,
    observationIds: [observation.id],
    ...(output ? { rawRef: { relPath: output.relPath, sha256: output.sha256 } } : {}),
  });
}

/** A finding from an observation: its title is what was found, its
    description why it stands out, and its source run is the analysis, so
    the chain starts there. */
export function findingFromObservation(input: {
  run: AnalysisRun;
  observation: Observation;
  label: string;
  shown: string;
  hint?: string;
  /** The file's name, as the finding's affected target. */
  target: string;
  now: number;
}): Finding {
  const finding = manualFinding(
    {
      title: observationTitle(input.observation, input.label, input.shown),
      severity: "info",
      target: input.target,
      description: input.hint,
    },
    { id: createId("fnd"), engagementId: input.run.engagementId, now: input.now },
  );
  return { ...finding, sourceRunId: input.run.id };
}

/**
 * The evidence that already keeps this observation: the row that pins its
 * id, or one kept from an earlier run of the same step on the same file
 * with the same title. A copy's bytes do not change, so a run of the same
 * step again finds the same thing under new ids.
 */
export function pinnedEvidence(
  evidence: readonly Evidence[],
  run: AnalysisRun,
  observation: Observation,
  title: string,
): Evidence | undefined {
  const source = sourceOf(run);
  let same: Evidence | undefined;
  for (const item of evidence) {
    if (item.kind !== "observation") continue;
    if (item.observationIds?.includes(observation.id)) return item;
    if (!same && item.fileId === run.fileId && item.source === source && item.title === title) {
      same = item;
    }
  }
  return same;
}
