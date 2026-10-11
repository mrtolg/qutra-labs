import type { Evidence, Finding } from "@/domain/findings";
import type { Engagement, Target } from "@/domain/lab";
import { analysis, type AnalysisRun } from "@/lib/analysis";
import type { NativeToolRun } from "@/lib/bridge/types";
import { getDb } from "@/lib/db/database";
import { externalTools } from "@/lib/externalTools";
import type { MessageKey } from "@/lib/i18n/en";
import { investigationFiles, type InvestigationFile } from "@/lib/investigationFiles";
import { useLabRuntime } from "@/state/labRuntime";
import { STEP_NAMES, observationLabel, observationShown, own } from "./analysisLabels";
import { latestRuns } from "./analysisPlan";
import { fileKindLabelKey } from "./fileKinds";
import { engagementStatusLabel, findingStatusLabel, runStateLabel } from "./labels";
import { isSensitiveObservation } from "./observationEvidence";
import { maskForReport } from "./reportBuild";
import { en } from "@/lib/i18n/en";

/* An investigation's summary as Jarvis may receive it (spec D9,
   §7.5): target names, files, scan summaries and
   finding titles, in the app's language, and nothing else. No evidence
   content, raw output, hash or sensitive value goes in, folder paths and
   locations are masked as a report masks them, and the first line says the
   block is data. The consent card shows this exact text, masked by Rust,
   before it goes. Lab-only. */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** The most characters the block may have. */
export const SUMMARY_LIMIT = 8 * 1024;

/** The block within `limit`, cut at a line's end, so no line -- a command,
    a value Rust would mask -- goes out in part. Findings come before the
    scans, so a long list of scans is what a cut drops. */
function fit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = text.lastIndexOf("\n", limit - 2);
  return `${text.slice(0, Math.max(end, 0))}\n…`;
}
/** How many of each list are named; the rest are counted. */
const SHOWN = { targets: 30, files: 30, scans: 30, findings: 50 };
/** The most characters one entry (a name, a title, a command) may have. */
const ENTRY_CHARS = 240;
/** The most characters the targets line, or the files line, may have, so
    neither can push the findings out of the block. */
const LIST_CHARS = 1500;

/** Free text as one line of at most `max` characters, cut between words. A
    title or a name with line breaks cannot add lines of its own to the
    block, and a cut never splits a word Rust would mask. */
function oneLine(text: string, max = ENTRY_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const space = flat.lastIndexOf(" ", max - 2);
  return space > 0 ? `${flat.slice(0, space)} …` : "…";
}

/** The opening words of a marker line: up to its first `.` or `:`. */
function lead(marker: string): string {
  return marker.split(/[.:]/)[0]!.trim();
}

/** `text` with the words of the block's own header and end lines taken out.
    A file name, a finding title or a value read from a sample could repeat
    them and then give an instruction, and a model would read it as coming
    after the data. The words of the app's language and of English both go. */
export function defang(text: string, markers: readonly string[]): string {
  let out = text;
  for (const marker of markers) {
    if (marker.length < 8) continue;
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out = out.replace(new RegExp(escaped, "giu"), "…");
  }
  return out;
}

export interface SummaryInput {
  engagement: Engagement;
  targets: readonly Target[];
  files: readonly InvestigationFile[];
  analysisRuns: readonly AnalysisRun[];
  toolRuns: readonly NativeToolRun[];
  findings: readonly Finding[];
  evidence: readonly Evidence[];
  t: Translate;
  locale: string;
}

/** A list's first `limit` items, then "+N more". With `maxChars`, it also
    stops before the items joined by ", " would pass that many characters. */
function capped(items: string[], limit: number, t: Translate, maxChars = Infinity): string[] {
  const shown: string[] = [];
  let length = 0;
  for (const item of items.slice(0, limit)) {
    if (length + item.length + 2 > maxChars) break;
    shown.push(item);
    length += item.length + 2;
  }
  return shown.length < items.length
    ? [...shown, t("lab.summary.more", { count: items.length - shown.length })]
    : shown;
}

/** One line of what a file's built-in steps found. */
function fileScan(file: InvestigationFile, runs: readonly AnalysisRun[], t: Translate, locale: string) {
  const latest = [...latestRuns(runs, file.id).values()].filter((run) => run.state === "finished");
  if (latest.length === 0) return null;
  const steps = latest.map((run) => {
    const key = own(STEP_NAMES, run.analyzer);
    return key ? t(key) : run.analyzer;
  });
  const found = latest.flatMap((run) =>
    run.observations
      .filter((o) => o.group === "interesting")
      .map((o) =>
        isSensitiveObservation(o.key)
          ? oneLine(observationLabel(t, o))
          : oneLine(`${observationLabel(t, o)}: ${observationShown(t, locale, o)}`),
      ),
  );
  return `- ${oneLine(file.name)} (${t(fileKindLabelKey(file.kind))}) · ${steps.join(", ")} · ${
    found.length > 0 ? found.join("; ") : t("lab.summary.quiet")
  }`;
}

/** The summary block, masked for paths and locations, within the limit. */
export function investigationSummary(input: SummaryInput): string {
  const { engagement, t, locale } = input;
  const none = t("lab.summary.none");
  const proven = new Set(input.evidence.map((item) => item.findingId).filter(Boolean));

  const targets = capped(
    input.targets.map((target) => oneLine(target.normalized || target.raw)),
    SHOWN.targets,
    t,
    LIST_CHARS,
  );
  const files = capped(
    input.files.map((file) => `${oneLine(file.name)} (${t(fileKindLabelKey(file.kind))})`),
    SHOWN.files,
    t,
    LIST_CHARS,
  );
  const scans = capped(
    [
      ...input.files
        .map((file) => fileScan(file, input.analysisRuns, t, locale))
        .filter((line): line is string => line !== null),
      // A run a descriptor made (ExifTool, YARA, capinfos) is told with its
      // file, through its observations; its command, arguments and output
      // tails hold the verified copy's local path and never go.
      ...input.toolRuns
        .filter((run) => !run.descriptorId)
        .map((run) => `- ${oneLine(run.commandPreview)} · ${runStateLabel(t, run.state)}`),
    ],
    SHOWN.scans,
    t,
  );
  const findings = capped(
    input.findings.map((finding) => {
      const parts = [
        `- [${t(`lab.severity.${finding.severity}` as MessageKey)}] ${oneLine(finding.title)}`,
        findingStatusLabel(t, finding.status),
      ];
      if (!proven.has(finding.id)) parts.push(t("lab.summary.draft"));
      return parts.join(" · ");
    }),
    SHOWN.findings,
    t,
  );

  const markers = [
    t("lab.summary.header"),
    t("lab.summary.end"),
    en["lab.summary.header"],
    en["lab.summary.end"],
  ].map(lead);
  const lines = [
    t("lab.summary.header"),
    t("lab.summary.investigation", {
      title: oneLine(engagement.title),
      status: engagementStatusLabel(t, engagement.status),
    }),
    t("lab.summary.targets", {
      count: input.targets.length,
      list: targets.length > 0 ? targets.join(", ") : none,
    }),
    t("lab.summary.files", {
      count: input.files.length,
      list: files.length > 0 ? files.join(", ") : none,
    }),
    t("lab.summary.findings", { count: input.findings.length }),
    ...(findings.length > 0 ? findings : [`- ${none}`]),
    t("lab.summary.scans"),
    ...(scans.length > 0 ? scans : [`- ${none}`]),
  ];
  // The end line comes after the cut, so the block always says where it
  // ends and the question begins.
  const end = t("lab.summary.end");
  const guarded = lines.map((line, index) => (index === 0 ? line : defang(line, markers)));
  const body = maskForReport(guarded.join("\n"), t("lab.report.md.locationHidden")).text;
  return `${fit(body, SUMMARY_LIMIT - end.length - 1)}\n${end}`;
}

/** The summary of the investigation with this id, from what the app keeps;
    null when the investigation is gone. */
export async function loadInvestigationSummary(
  engagementId: string,
  t: Translate,
  locale: string,
): Promise<string | null> {
  const db = getDb();
  const engagement = db.collection("engagements").get(engagementId);
  if (!engagement) return null;
  const ofThis = <T extends { engagementId?: string }>(rows: readonly T[]) =>
    rows.filter((row) => row.engagementId === engagementId);
  const [files, analysisRuns, toolAnalysis] = await Promise.all([
    investigationFiles.available()
      ? investigationFiles.list(engagementId).catch(() => [])
      : Promise.resolve([]),
    analysis.available() ? analysis.list(engagementId).catch(() => []) : Promise.resolve([]),
    // Needs Private Lab: without it there is nothing to say about them.
    externalTools.available()
      ? externalTools.runs(engagementId).catch((): AnalysisRun[] => [])
      : Promise.resolve([] as AnalysisRun[]),
  ]);
  return investigationSummary({
    engagement,
    targets: ofThis(db.collection("targets").getAll()),
    files,
    analysisRuns: [...analysisRuns, ...toolAnalysis],
    toolRuns: ofThis(useLabRuntime.getState().runs),
    findings: ofThis(db.collection("findings").getAll()),
    evidence: ofThis(db.collection("evidence").getAll()),
    t,
    locale,
  });
}
