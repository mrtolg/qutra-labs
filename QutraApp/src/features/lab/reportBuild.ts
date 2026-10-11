import type { Evidence, Finding, FindingStatus } from "@/domain/findings";
import type { Engagement } from "@/domain/lab";
import { buildMarkdownReport, type ReportWords } from "@/domain/lab/reportOps";
import type { MessageKey } from "@/lib/i18n/en";
import { findingStatusLabel } from "./labels";

/* The engagement report as the Rapor view previews it and saves it (spec
   2026-10-07 §4.7, D6): one builder for both, so the file holds
   what the preview shows. A draft never goes in (not until
   evidence is linked). Lab-only. */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export interface ReportOptions {
  /** False positives, duplicates and findings out of scope. */
  includeDismissed: boolean;
  /** Mask locations, folder paths and sensitive evidence. */
  mask: boolean;
}

export const DEFAULT_REPORT_OPTIONS: ReportOptions = {
  includeDismissed: false,
  mask: true,
};

/** Statuses that say a finding does not stand. */
export const DISMISSED: ReadonlySet<FindingStatus> = new Set<FindingStatus>([
  "false_positive",
  "duplicate",
  "out_of_scope",
]);

export interface LabReportWords extends ReportWords {
  /** What a masked location becomes. */
  locationHidden: string;
}

/** The report's own words in the app's language. */
export function reportWords(t: Translate): LabReportWords {
  return {
    title: (engagement) => t("lab.report.md.title", { title: engagement }),
    generated: t("lab.report.md.generated"),
    executiveSummary: t("lab.report.md.executiveSummary"),
    summaryLine: (count, engagement) => t("lab.report.md.summaryLine", { count, title: engagement }),
    recordSummary: (count) => t("lab.report.md.recordSummary", { count }),
    severitySummary: t("lab.report.md.severitySummary"),
    findings: t("lab.report.md.findings"),
    noFindings: t("lab.report.md.noFindings"),
    severity: t("lab.report.md.severity"),
    status: t("lab.report.md.status"),
    confidence: t("lab.report.md.confidence"),
    sourceTool: t("lab.report.md.sourceTool"),
    targets: t("lab.report.md.targets"),
    location: t("lab.report.md.location"),
    impact: t("lab.report.md.impact"),
    reproduction: t("lab.report.md.reproduction"),
    remediation: t("lab.report.md.remediation"),
    evidence: t("lab.report.md.evidence"),
    withheld: t("lab.report.md.withheld"),
    footer: t("lab.report.md.footer"),
    severityName: (severity) => t(`lab.severity.${severity}` as MessageKey),
    statusName: (status) => findingStatusLabel(t, status),
    confidenceName: (confidence) => t(`lab.report.md.confidence.${confidence}` as MessageKey),
    locationHidden: t("lab.report.md.locationHidden"),
  };
}

/** The findings a report holds, and how many each rule left out. A draft
    never goes in; a dismissed draft counts once, as a draft. */
export function selectReportFindings(
  findings: readonly Finding[],
  evidence: readonly Evidence[],
  options: ReportOptions,
): { included: Finding[]; drafts: number; dismissed: number } {
  const proven = new Set(evidence.map((item) => item.findingId).filter(Boolean));
  let drafts = 0;
  let dismissed = 0;
  const included = findings.filter((finding) => {
    if (!proven.has(finding.id)) {
      drafts += 1;
      return false;
    }
    if (!options.includeDismissed && DISMISSED.has(finding.status)) {
      dismissed += 1;
      return false;
    }
    return true;
  });
  return { included, drafts, dismissed };
}

/* ---- Masking ----
   Every pattern is linear: bounded repeats, no nested ambiguity. */

/** Degrees, minutes and seconds with a hemisphere: 41 deg 0' 29.52" N. */
const DMS = /\d{1,3}\s*(?:°|deg)\s*\d{1,2}\s*['′]\s*\d{1,2}(?:\.\d+)?\s*(?:"|″|'')?\s*[NSEWnsew]\b/g;
/** Decimal degrees with the degree sign: 41.0082° N, 28.9784° E. */
const DEGREES =
  /-?\d{1,3}(?:\.\d+)?\s*°\s*[NSns]?\s*,?\s*-?\d{1,3}(?:\.\d+)?\s*°\s*[EWew]?/g;
/** A named latitude or longitude: "lat": 41.0082, GPS Latitude : 41.0082. */
const NAMED =
  /((?:"?\b(?:lat|latitude|lon|lng|longitude)"?\s*[:=]\s*)|(?:\bGPS\s*(?:Latitude|Longitude|Position|Coordinates)\s*[:=]\s*))-?\d{1,3}(?:\.\d+)?/gi;
/** A decimal pair, as a photo's GPS reads: 41.008200, 28.978400 (a
    sentence's full stop may follow it, a further digit may not). */
const PAIR = /(?<!\d)(?<!\d\.)(-?\d{1,3}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})(?!\.?\d)/g;

/** One path part: no separators, and nothing that ends a path in prose
    (a colon, a semicolon, a quote). An apostrophe inside a name (O'Brien)
    belongs to it; one that opens or closes the path does not. */
const WORD = String.raw`[^\\/\s"'<>|*?:;]+(?:'[^\\/\s"'<>|*?:;]+)*`;
/** A Windows folder or file name: up to four words with single spaces
    (Program Files, Jane Doe), but never a word that starts the next drive. */
const NAME = String.raw`${WORD}(?: (?![A-Za-z]:)${WORD}){0,3}`;
/** A Windows path with at least one folder: a drive or a UNC share, with \
    (doubled in JSON text) or / as separators. */
const WINDOWS_PATH = new RegExp(
  String.raw`(?:\b[A-Za-z]:[\\/]+|\\\\)(?:${NAME}[\\/]+)+(?:${NAME})?`,
  "g",
);
/** A Linux or macOS home path, not inside a URL: /home/bob/notes.txt. */
const HOME_PATH = new RegExp(String.raw`(?<![\w.-])\/(?:home|Users)\/${WORD}(?:\/${WORD})*\/?`, "g");
/** Folders that hold one user's things: the name after them is the user. */
const USER_ROOTS = /^(?:users|home|documents and settings)$/i;

/** A path as the report shows it: its last part only, unless that part is
    a user's own folder, which goes too. */
function maskPath(path: string): string {
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]+/);
  const last = parts[parts.length - 1] ?? "";
  const userFolder = USER_ROOTS.test(parts[parts.length - 2] ?? "");
  return `…${separator}${last && !userFolder ? last : "…"}`;
}

/** Mask locations and folder paths in one piece of text. A path keeps its
    last part (usually the file name); the folders before it can name the
    person who ran the tool. */
export function maskForReport(
  text: string,
  hidden: string,
): { text: string; locations: number; paths: number } {
  let locations = 0;
  let paths = 0;
  const location = () => {
    locations += 1;
    return hidden;
  };
  const masked = text
    .replace(DMS, location)
    .replace(DEGREES, location)
    .replace(NAMED, (_match, key: string) => `${key}${location()}`)
    .replace(PAIR, (match, lat: string, lon: string) =>
      Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180 ? location() : match,
    )
    .replace(WINDOWS_PATH, (path) => {
      paths += 1;
      return maskPath(path);
    })
    .replace(HOME_PATH, (path) => {
      paths += 1;
      return maskPath(path);
    });
  return { text: masked, locations, paths };
}

export interface BuiltReport {
  markdown: string;
  /** The findings the report holds, unmasked. */
  included: Finding[];
  left: { drafts: number; dismissed: number };
  masked: { locations: number; paths: number; sensitive: number };
}

/** Evidence text past this length is cut by the report; masking and its
    counts stop there too. */
const EVIDENCE_SHOWN = 4000;

/** The engagement's report, as the preview shows it and the file holds it. */
export function buildEngagementReport(input: {
  engagement: Engagement;
  findings: readonly Finding[];
  evidence: readonly Evidence[];
  options: ReportOptions;
  words: LabReportWords;
  now: number;
}): BuiltReport {
  const { engagement, options, words } = input;
  const findings = input.findings.filter((f) => f.engagementId === engagement.id);
  const evidence = input.evidence.filter((e) => e.engagementId === engagement.id);
  const { included, drafts, dismissed } = selectReportFindings(findings, evidence, options);

  const masked = { locations: 0, paths: 0, sensitive: 0 };
  const mask = (text: string): string => {
    if (!options.mask || !text) return text;
    const result = maskForReport(text, words.locationHidden);
    masked.locations += result.locations;
    masked.paths += result.paths;
    return result.text;
  };
  const shown = evidence.filter(
    (item) =>
      item.includeInReport &&
      included.some((f) => item.findingId === f.id || f.evidenceIds.includes(item.id)),
  );
  const shownEvidence = shown.map((item) => {
    if (options.mask && item.sensitivity === "sensitive") {
      masked.sensitive += 1;
      return { ...item, title: mask(item.title) };
    }
    const content = item.content.trim() ? mask(item.content.slice(0, EVIDENCE_SHOWN)) : "";
    // The path is printed only for a row without content.
    const path = content ? item.path : mask(item.path);
    return { ...item, title: mask(item.title), content, path };
  });
  const shownFindings = included.map((f) => ({
    ...f,
    title: mask(f.title),
    description: mask(f.description),
    impact: mask(f.impact),
    reproduction: mask(f.reproduction),
    remediation: mask(f.remediation),
    location: mask(f.location),
    sourceTool: mask(f.sourceTool),
    affectedTargets: f.affectedTargets.map(mask),
  }));

  const markdown = buildMarkdownReport({
    engagement: { ...engagement, title: mask(engagement.title) },
    findings: shownFindings,
    evidence: shownEvidence,
    now: input.now,
    words,
    withholdSensitive: options.mask,
  });
  return { markdown, included, left: { drafts, dismissed }, masked };
}
