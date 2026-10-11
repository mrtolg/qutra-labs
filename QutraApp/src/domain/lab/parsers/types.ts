import type { Severity } from "@/domain/findings";

/* Parser framework contracts. A parser turns tool output (text) into a
   deterministic set of ImportedFindings; it never executes the content and
   surfaces warnings + a rejected count rather than throwing on bad rows. */

export interface ImportedFinding {
  title: string;
  description?: string;
  severity: Severity;
  ruleId?: string;
  affectedTargets?: string[];
  location?: string;
  cwe?: string[];
  cve?: string[];
  references?: string[];
  /** Small raw excerpt kept for provenance (never the whole artifact). */
  raw?: string;
}

export interface ParseResult {
  parser: string;
  parserVersion: string;
  findings: ImportedFinding[];
  warnings: string[];
  /** Rows/results that were skipped as malformed. */
  rejected: number;
  meta: Record<string, string>;
}

/** Why a parser refused an input, as a code the page words in the user's
    language. The message stays English, for logs. */
export type ParseErrorCode =
  | "too_large"
  | "not_json"
  | "bad_xml"
  | "not_nmap"
  | "no_runs"
  | "no_dom_parser";

export class ParseError extends Error {
  constructor(
    message: string,
    readonly code: ParseErrorCode,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

/** Guard: reject absurdly large inputs before parsing (bounded memory). */
export const MAX_PARSE_BYTES = 25 * 1024 * 1024;

export function assertParseSize(text: string): void {
  // Byte length approximation is fine for a guard.
  if (text.length > MAX_PARSE_BYTES) {
    throw new ParseError("input exceeds the maximum parse size", "too_large");
  }
}
