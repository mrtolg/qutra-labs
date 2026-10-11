import type { ExclusionRule } from "@/domain/types";
import type { MessageKey } from "@/lib/i18n/en";

/* An exclusion is a value that never leaves the computer: Rust replaces it
   in everything that goes to a cloud service (`src-tauri/src/ai/exclusions.rs`),
   matching it without regard to case, a folder path with either slash. These
   are the rules the form checks before it saves one. */

/** The kinds the form offers. `app` stays readable for rules saved before. */
export type NewExclusionKind = Exclude<ExclusionRule["kind"], "app">;

export const NEW_EXCLUSION_KINDS: readonly NewExclusionKind[] = ["pattern", "domain", "path"];

/** Rust ignores shorter or longer values; three characters keeps a short
    value from masking parts of ordinary words. */
export const MIN_LENGTH = 3;
export const MAX_LENGTH = 256;
/** Rust reads at most this many. */
export const MAX_RULES = 500;
/** What Rust puts in a value's place; a value inside it would mask it again. */
export const EXCLUSION_MARKER = "[masked exclusion]";

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DRIVE_PATH = /^[a-z]:[\\/]/i;
const UNC_PATH = /^\\\\[^\\/]+[\\/]/;

export type ExclusionCheck =
  | { ok: true; value: string }
  | { ok: false; error: MessageKey };

/** Check and normalize a value the user typed for a new exclusion. */
export function checkExclusion(
  kind: NewExclusionKind,
  raw: string,
  existing: readonly Pick<ExclusionRule, "value">[],
): ExclusionCheck {
  let value = raw.trim();
  if (value === "") return { ok: false, error: "privacy2.error.empty" };
  if (/[\r\n\t]/.test(value)) return { ok: false, error: "privacy2.error.oneLine" };
  if (kind === "domain") {
    value = value.toLowerCase().replace(/\.$/, "");
    if (/^[a-z]+:\/\//.test(value) || value.includes("/")) {
      return { ok: false, error: "privacy2.error.domainOnly" };
    }
    if (!HOSTNAME.test(value)) return { ok: false, error: "privacy2.error.domain" };
  }
  if (kind === "path") {
    if (!DRIVE_PATH.test(value) && !UNC_PATH.test(value)) {
      return { ok: false, error: "privacy2.error.path" };
    }
    // `C:\Clients\` and `C:\Clients` are the same folder.
    if (value.length > 3) value = value.replace(/[\\/]+$/, "");
  }
  if (value.length < MIN_LENGTH) return { ok: false, error: "privacy2.error.short" };
  if (value.length > MAX_LENGTH) return { ok: false, error: "privacy2.error.long" };
  if (EXCLUSION_MARKER.toLowerCase().includes(value.toLowerCase())) {
    return { ok: false, error: "privacy2.error.marker" };
  }
  const same = value.toLowerCase();
  if (existing.some((rule) => rule.value.trim().toLowerCase() === same)) {
    return { ok: false, error: "privacy2.error.duplicate" };
  }
  if (existing.length >= MAX_RULES) return { ok: false, error: "privacy2.error.tooMany" };
  return { ok: true, value };
}
