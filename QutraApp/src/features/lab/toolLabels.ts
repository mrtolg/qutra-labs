import type { ArgDef, ToolProfile } from "@/domain/lab";
import type { ArgError } from "@/domain/lab/command";
import type { ScopeDecisionReason } from "@/domain/lab/scope";
import type { NativeSignatureState, NativeToolInstallation } from "@/lib/bridge/types";
import type { MessageKey } from "@/lib/i18n/en";

/* The words a registered tool is shown with. Rust and the profile store keep
   short codes ("network", "medium", "unsigned", "port_range"); the user reads
   them in their language, never as the code. */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export type ToolState = "ready" | "changed" | "disabled";

export function toolState(installation: NativeToolInstallation): ToolState {
  if (installation.changedSinceVerify) return "changed";
  if (!installation.enabled) return "disabled";
  return "ready";
}

const STATE_KEYS: Record<ToolState, MessageKey> = {
  ready: "lab.tools.state.ready",
  changed: "lab.tools.state.changed",
  disabled: "lab.tools.state.disabled",
};

const CATEGORY_KEYS: Record<NativeToolInstallation["category"], MessageKey> = {
  local: "tools.category.local",
  network: "tools.category.network",
  web: "tools.category.web",
  code: "tools.category.code",
  dfir: "tools.category.dfir",
};

const RISK_KEYS: Record<NativeToolInstallation["riskTier"], MessageKey> = {
  info: "lab.tools.riskLevel.info",
  low: "lab.tools.riskLevel.low",
  medium: "lab.tools.riskLevel.medium",
  high: "lab.tools.riskLevel.high",
};

const SIGNATURE_KEYS: Record<NativeSignatureState, MessageKey> = {
  valid: "lab.tools.signatureState.valid",
  invalid: "lab.tools.signatureState.invalid",
  unsigned: "lab.tools.signatureState.unsigned",
  unavailable: "lab.tools.signatureState.unavailable",
};

const ARG_TYPE_KEYS: Record<ArgDef["type"], MessageKey> = {
  string: "lab.argType.string",
  integer: "lab.argType.integer",
  boolean: "lab.argType.boolean",
  enum: "lab.argType.enum",
  file: "lab.argType.file",
  folder: "lab.argType.folder",
  target: "lab.argType.target",
  port_range: "lab.argType.port_range",
  duration: "lab.argType.duration",
};

export const ARG_TYPES = Object.keys(ARG_TYPE_KEYS) as ArgDef["type"][];

const ARG_ERROR_KEYS: Record<ArgError["code"], MessageKey> = {
  required: "lab.args.error.required",
  control_chars: "lab.args.error.control_chars",
  integer: "lab.args.error.integer",
  boolean: "lab.args.error.boolean",
  enum: "lab.args.error.enum",
  duration: "lab.args.error.duration",
  port_range: "lab.args.error.port_range",
  port_out_of_range: "lab.args.error.port_out_of_range",
  traversal: "lab.args.error.traversal",
};

const KIND_HINT_KEYS: Record<ToolProfile["launchKind"], MessageKey> = {
  gui: "lab.tools.kindHint.gui",
  interactive: "lab.tools.kindHint.interactive",
  batch: "lab.tools.kindHint.batch",
};

export const toolStateLabel = (t: Translate, state: ToolState) => t(STATE_KEYS[state]);
export const toolCategoryLabel = (t: Translate, category: NativeToolInstallation["category"]) =>
  t(CATEGORY_KEYS[category]);
export const toolRiskLabel = (t: Translate, tier: NativeToolInstallation["riskTier"]) =>
  t(RISK_KEYS[tier]);
export const signatureLabel = (t: Translate, state: NativeSignatureState) =>
  t(SIGNATURE_KEYS[state]);
export const argTypeLabel = (t: Translate, type: ArgDef["type"]) => t(ARG_TYPE_KEYS[type]);
export const launchKindHint = (t: Translate, kind: ToolProfile["launchKind"]) =>
  t(KIND_HINT_KEYS[kind]);
export const scopeDecisionLabel = (t: Translate, reason: ScopeDecisionReason) =>
  t(`lab.decision.${reason}` as MessageKey);

export function argErrorText(t: Translate, error: ArgError, args: readonly ArgDef[]): string {
  const values = args.find((arg) => arg.id === error.argId)?.enumValues.join(", ") ?? "";
  return t(ARG_ERROR_KEYS[error.code], { name: error.name, values });
}

/** Windows hands back verbatim paths (\\?\C:\…); people read C:\…. */
export function displayPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

export function formatBytes(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[unit]}`;
}
