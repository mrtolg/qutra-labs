import type { Severity } from "@/domain/findings";
import {
  assertParseSize,
  ParseError,
  type ImportedFinding,
  type ParseResult,
} from "./types";

/* SARIF 2.1.0 importer (docs.oasis-open.org/sarif/sarif/v2.1.0). Reads the
   documented result/level/rule structure; unknown fields are ignored. */

export const SARIF_PARSER_VERSION = "1.0.0";

const LEVEL_TO_SEVERITY: Record<string, Severity> = {
  error: "high",
  warning: "medium",
  note: "low",
  none: "info",
};

interface SarifRule {
  id?: string;
  name?: string;
  shortDescription?: { text?: string };
  fullDescription?: { text?: string };
  helpUri?: string;
  defaultConfiguration?: { level?: string };
  properties?: { tags?: string[]; cwe?: string | string[]; [k: string]: unknown };
}

interface SarifResult {
  ruleId?: string;
  rule?: { id?: string };
  level?: string;
  message?: { text?: string };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }>;
}

function cweFromTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const out = new Set<string>();
  for (const tag of tags) {
    const m = /^(?:external\/cwe\/)?cwe-?(\d+)$/i.exec(tag);
    if (m) out.add(`CWE-${m[1]}`);
  }
  return [...out];
}

export function parseSarif(text: string): ParseResult {
  assertParseSize(text);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ParseError("input is not valid JSON", "not_json");
  }
  const root = doc as { version?: string; $schema?: string; runs?: unknown[] };
  const warnings: string[] = [];
  if (root.version && root.version !== "2.1.0") {
    // A code and its value, worded by the page: `sarif_version:<version>`.
    warnings.push(`sarif_version:${root.version}`);
  }
  if (!Array.isArray(root.runs)) {
    throw new ParseError("SARIF document has no runs array", "no_runs");
  }

  const findings: ImportedFinding[] = [];
  let rejected = 0;
  const meta: Record<string, string> = {};

  for (const runU of root.runs) {
    const run = runU as {
      tool?: { driver?: { name?: string; rules?: SarifRule[] } };
      results?: SarifResult[];
    };
    const driver = run.tool?.driver;
    if (driver?.name) meta.tool = driver.name;
    const rulesById = new Map<string, SarifRule>();
    for (const r of driver?.rules ?? []) if (r.id) rulesById.set(r.id, r);

    for (const result of run.results ?? []) {
      const ruleId = result.ruleId ?? result.rule?.id ?? "";
      const rule = ruleId ? rulesById.get(ruleId) : undefined;
      const level =
        result.level ?? rule?.defaultConfiguration?.level ?? "warning";
      const severity = LEVEL_TO_SEVERITY[level] ?? "medium";
      const title =
        rule?.name ??
        rule?.shortDescription?.text ??
        result.message?.text ??
        ruleId ??
        "Finding";
      if (!title) {
        rejected++;
        continue;
      }
      const targets: string[] = [];
      for (const loc of result.locations ?? []) {
        const uri = loc.physicalLocation?.artifactLocation?.uri;
        const line = loc.physicalLocation?.region?.startLine;
        if (uri) targets.push(line ? `${uri}:${line}` : uri);
      }
      const cwe = new Set<string>(cweFromTags(rule?.properties?.tags));
      const propCwe = rule?.properties?.cwe;
      if (typeof propCwe === "string") cwe.add(propCwe.toUpperCase());
      else if (Array.isArray(propCwe)) for (const c of propCwe) cwe.add(String(c).toUpperCase());

      findings.push({
        title,
        description: result.message?.text ?? rule?.fullDescription?.text ?? "",
        severity,
        ruleId,
        affectedTargets: targets,
        location: targets[0] ?? "",
        cwe: [...cwe],
        references: rule?.helpUri ? [rule.helpUri] : [],
      });
    }
  }

  return {
    parser: "sarif",
    parserVersion: SARIF_PARSER_VERSION,
    findings,
    warnings,
    rejected,
    meta,
  };
}
