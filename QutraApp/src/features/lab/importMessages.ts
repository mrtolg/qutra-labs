import { ParseError } from "@/domain/lab/parsers/types";
import type { MessageKey } from "@/lib/i18n/en";

/* What the scan import tells the user when an output cannot be read or reads
   with a caveat, in the app's language: the parsers speak in codes. */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** The words for a parser that refused an input. */
export function importErrorKey(error: unknown): MessageKey {
  if (!(error instanceof ParseError)) return "lab.import.error.generic";
  switch (error.code) {
    case "too_large":
      return "lab.import.error.tooLarge";
    case "not_json":
      return "lab.import.error.notJson";
    case "bad_xml":
      return "lab.import.error.badXml";
    case "not_nmap":
      return "lab.import.error.notNmap";
    case "no_runs":
      return "lab.import.error.noRuns";
    default:
      return "lab.import.error.generic";
  }
}

/** The words for one warning a parser returned (`code` or `code:value`). */
export function importWarningText(t: Translate, warning: string): string {
  const [code, ...rest] = warning.split(":");
  if (code === "sarif_version") return t("lab.import.warn.sarifVersion", { version: rest.join(":") });
  return warning;
}
