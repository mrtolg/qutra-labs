import type { ArgDef, ToolProfile } from "../lab";

/* ============================================================
   Typed argument → argument-array builder (pure).

   The native layer receives the executable and an argument ARRAY
   separately; there is never a shell string, so shell injection
   is impossible by construction. This module still validates each
   value (type, traversal, control characters) and produces an
   exact, human-readable command preview with correct quoting.
   ============================================================ */

/** Why a value was refused, for the UI to say in the user's language. */
export type ArgErrorCode =
  | "required"
  | "control_chars"
  | "integer"
  | "boolean"
  | "enum"
  | "duration"
  | "port_range"
  | "port_out_of_range"
  | "traversal";

export interface ArgError {
  argId: string;
  name: string;
  code: ArgErrorCode;
  /** The same reason in English, for logs and tests. */
  message: string;
}

type Refusal = Pick<ArgError, "code" | "message">;

export interface BuiltCommand {
  argv: string[];
  preview: string;
  errors: ArgError[];
  /** The values of arguments marked sensitive, exactly as they went into
      `argv` (trimmed, and split when repeatable), so Rust's exact-match
      redaction finds them in previews and logs. */
  sensitive: string[];
}

/** True if the value contains a NUL, C0 control char or DEL (0x7f). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function validateValue(def: ArgDef, value: string): Refusal | null {
  if (hasControlChar(value)) {
    return { code: "control_chars", message: "control characters are not allowed" };
  }
  switch (def.type) {
    case "integer":
      return /^-?\d+$/.test(value) ? null : { code: "integer", message: "must be an integer" };
    case "boolean":
      return value === "true" || value === "false"
        ? null
        : { code: "boolean", message: "must be true or false" };
    case "enum":
      return def.enumValues.includes(value)
        ? null
        : { code: "enum", message: `must be one of: ${def.enumValues.join(", ")}` };
    case "duration":
      return /^\d+(ms|s|m|h)?$/.test(value)
        ? null
        : { code: "duration", message: "must be a duration (e.g. 30s, 5m)" };
    case "port_range": {
      const parts = value.split(",");
      for (const part of parts) {
        const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
        if (!m) {
          return {
            code: "port_range",
            message: "must be a port or port range (e.g. 80,443,8000-8100)",
          };
        }
        if (Number(m[1]) > 65535 || (m[2] && Number(m[2]) > 65535)) {
          return { code: "port_out_of_range", message: "port out of range" };
        }
      }
      return null;
    }
    case "file":
    case "folder":
      if (value.includes("..")) {
        return { code: "traversal", message: "path traversal is not allowed" };
      }
      return null;
    case "target":
    case "string":
    default:
      return null;
  }
}

/** Quote a token for the human-readable preview (display only). */
function quoteForPreview(token: string): string {
  if (token === "") return '""';
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `"${token.replace(/(["\\$`])/g, "\\$1")}"`;
}

function expandValues(def: ArgDef, value: string): string[] {
  if (!def.repeatable) return [value];
  return value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export interface BuildOptions {
  /** Override saved profile values (e.g. from the run form). */
  values?: Record<string, string>;
  /** Executable/runner label to prepend in the preview only. */
  executableLabel?: string;
}

/**
 * Resolve a profile's arguments into an argv array + preview, collecting
 * per-argument validation errors. `argv` never includes the executable —
 * the native layer owns that, keyed by ToolInstallation id.
 */
export function buildCommand(profile: ToolProfile, opts: BuildOptions = {}): BuiltCommand {
  const provided = { ...profile.values, ...(opts.values ?? {}) };
  const errors: ArgError[] = [];
  const argv: string[] = [];
  const sensitive: string[] = [];

  const ordered = [...profile.args].sort((a, b) => a.order - b.order);

  for (const def of ordered) {
    const raw = provided[def.id] ?? def.default ?? "";
    const value = raw.trim();

    if (!value) {
      if (def.required) {
        errors.push({ argId: def.id, name: def.name, code: "required", message: "is required" });
      }
      continue;
    }

    if (def.type === "boolean") {
      const err = validateValue(def, value);
      if (err) {
        errors.push({ argId: def.id, name: def.name, ...err });
        continue;
      }
      // A true boolean emits its flag (if any) with no value; false emits nothing.
      if (value === "true" && def.flag) argv.push(def.flag);
      continue;
    }

    for (const one of expandValues(def, value)) {
      const err = validateValue(def, one);
      if (err) {
        errors.push({ argId: def.id, name: def.name, ...err });
        continue;
      }
      if (def.flag) argv.push(def.flag);
      argv.push(one);
      if (def.sensitive) sensitive.push(one);
    }
  }

  const previewTokens = [
    ...(opts.executableLabel ? [opts.executableLabel] : []),
    ...argv,
  ].map(quoteForPreview);

  return { argv, preview: previewTokens.join(" "), errors, sensitive };
}
