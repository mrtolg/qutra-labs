import raw from "./toolForms.json?raw";
import type { NativeToolInstallation } from "@/lib/bridge/types";

/* Purpose-built run forms. The same data file is read
   by Rust (src-tauri/src/tool_forms.rs), which builds the argument list and
   is the authority on every value; this side draws the form, checks values
   as they are typed with the same rules, and previews the command. The page
   sends only the form, the preset and the typed values. */

export type FieldType = "target" | "ports" | "int" | "text" | "file" | "folder" | "output";
export type OutputKind = "nmap-xml" | "json" | "jsonl" | "csv" | "keyvalue" | "lines" | "text";

export interface FormField {
  id: string;
  type: FieldType;
  required?: boolean;
  default?: string;
  accepts?: string[];
  min?: number;
  max?: number;
  pattern?: string;
  maxLen?: number;
  ext?: string;
  noIncludes?: boolean;
}

export interface FormPreset {
  id: string;
  output: OutputKind;
  argv: string[];
  launch?: "gui";
  network?: string;
  stdinPaths?: boolean;
}

export interface ToolForm {
  id: string;
  executables: string[];
  timeoutSec: number;
  fixture?: boolean;
  env?: Record<string, string>;
  fields: FormField[];
  presets: FormPreset[];
}

const DEFAULT_TEXT_MAX = 256;
const PLACEHOLDER = /\{([A-Za-z0-9]+)\}/g;

export const TOOL_FORMS: readonly ToolForm[] = (JSON.parse(raw) as { forms: ToolForm[] }).forms;

/** The program's file name, in lower case: `C:\…\nmap.exe` → `nmap.exe`. */
export function executableName(installation: Pick<NativeToolInstallation, "canonicalPath">): string {
  return (installation.canonicalPath.split(/[\\/]/).pop() ?? "").toLowerCase();
}

/** The form written for this program, by its executable's file name. */
export function formFor(
  installation: Pick<NativeToolInstallation, "canonicalPath">,
): ToolForm | undefined {
  const name = executableName(installation);
  return TOOL_FORMS.find((form) => form.executables.some((exe) => exe.toLowerCase() === name));
}

/** The test program that checks the run path; never an investigation tool. */
export function isFixture(
  installation: Pick<NativeToolInstallation, "canonicalPath" | "displayName">,
): boolean {
  return (
    formFor(installation)?.fixture === true ||
    /contextos[\s_-]*fixture/i.test(installation.displayName)
  );
}

/** The field ids a preset's arguments name, in order, each once. */
export function usedFields(preset: FormPreset): string[] {
  const used: string[] = [];
  for (const token of preset.argv) {
    for (const match of token.matchAll(PLACEHOLDER)) {
      if (!used.includes(match[1]!)) used.push(match[1]!);
    }
  }
  return used;
}

/** The fields the user fills in for this preset: files, targets, numbers and
    text. The folder and the output file are chosen by Rust. */
export function inputFields(form: ToolForm, preset: FormPreset): FormField[] {
  // In the data file's order (the target first), not the argument order.
  const used = usedFields(preset);
  return form.fields.filter(
    (field) => used.includes(field.id) && field.type !== "folder" && field.type !== "output",
  );
}

export function presetUses(form: ToolForm, preset: FormPreset, type: FieldType): boolean {
  return usedFields(preset).some(
    (id) => form.fields.find((field) => field.id === id)?.type === type,
  );
}

function validPorts(value: string): boolean {
  const parts = value.split(",");
  if (parts.length === 0 || parts.length > 100) return false;
  return parts.every((part) => {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!m) return false;
    const low = Number(m[1]);
    const high = m[2] === undefined ? low : Number(m[2]);
    return low >= 1 && high <= 65535 && low <= high;
  });
}

export type FieldProblem = "required" | "invalid";

/** The same check Rust makes (`check_value`), for the message under a field
    while it is typed. `null` when the value passes. */
export function checkValue(field: FormField, raw: string): FieldProblem | null {
  const value = raw.trim() || (field.default ?? "").trim();
  if (!value) return field.type === "folder" || field.type === "output" ? null : "required";
  const control = [...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
  if (control || value.startsWith("-")) return "invalid";
  switch (field.type) {
    case "target":
      return /^[A-Za-z0-9:[][A-Za-z0-9.:_/[\]%-]{0,252}$/.test(value) ? null : "invalid";
    case "ports":
      return validPorts(value) ? null : "invalid";
    case "int": {
      if (!/^-?\d+$/.test(value)) return "invalid";
      const n = Number(value);
      if (field.min !== undefined && n < field.min) return "invalid";
      if (field.max !== undefined && n > field.max) return "invalid";
      return null;
    }
    case "text":
      if ([...value].length > (field.maxLen ?? DEFAULT_TEXT_MAX)) return "invalid";
      if (field.pattern && !new RegExp(field.pattern).test(value)) return "invalid";
      return null;
    case "file":
      return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? null : "invalid";
    default:
      return null;
  }
}

/** Every field of the preset with a problem, keyed by field id. */
export function formProblems(
  form: ToolForm,
  preset: FormPreset,
  values: Record<string, string>,
): Record<string, FieldProblem> {
  const problems: Record<string, FieldProblem> = {};
  for (const field of inputFields(form, preset)) {
    const problem = checkValue(field, values[field.id] ?? "");
    if (problem) problems[field.id] = problem;
  }
  return problems;
}

/** The value a field runs with: what was typed, else its default. */
export function effectiveValue(field: FormField, values: Record<string, string>): string {
  return (values[field.id] ?? "").trim() || (field.default ?? "").trim();
}

/** What stands for a value in the preview when it is not a plain value. */
export interface PreviewNames {
  /** A file id → the file's name. */
  file: (id: string) => string;
  folder: string;
  output: string;
}

/** The command as it will run, for reading: placeholders filled with the
    typed values, a file shown by its name, the folder and the output file by
    a label. Rust builds the real argument list. */
export function previewTokens(
  form: ToolForm,
  preset: FormPreset,
  values: Record<string, string>,
  names: PreviewNames,
): string[] {
  return preset.argv.map((token) =>
    token.replace(PLACEHOLDER, (_whole, id: string) => {
      const field = form.fields.find((item) => item.id === id);
      if (!field) return "";
      if (field.type === "folder") return names.folder;
      if (field.type === "output") return names.output;
      const value = effectiveValue(field, values);
      if (field.type === "file") return value ? names.file(value) : `‹${id}›`;
      return value || `‹${id}›`;
    }),
  );
}

/** Quote a token for reading (display only). */
export function quoteToken(token: string): string {
  if (token === "") return '""';
  if (/^[A-Za-z0-9_@%+=:,./\\‹›*-]+$/u.test(token)) return token;
  return `"${token.replace(/"/g, '\\"')}"`;
}
