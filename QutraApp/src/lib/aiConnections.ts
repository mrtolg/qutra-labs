import { invoke } from "@tauri-apps/api/core";
import { getBridge } from "@/lib/bridge";

/* Cloud connections for Jarvis (spec 2026-10-07 §7). Rust keeps
   each key in Windows Credential Manager with the address it may be sent
   to (`src-tauri/src/ai/`). The page saves, tests for and deletes a key; it
   never reads one back, and it lists a connection's models to test it. */

export type OpenAiPreset = "openai" | "gemini" | "openrouter" | "groq" | "custom";

export type AiTarget =
  | { provider: "anthropic" }
  | { provider: "openai_compat"; preset: OpenAiPreset };

export interface KeyStatus {
  present: boolean;
  /** The key's last four characters; null for a local server without one. */
  last4: string | null;
  /** The address the key was saved for. */
  baseUrl: string | null;
}

export interface ModelInfo {
  id: string;
  name: string;
}

export type AiErrorCode =
  | "no_key"
  | "key_unreadable"
  | "address_not_found"
  | "key_invalid"
  | "billing"
  | "no_access"
  | "too_large"
  | "rate_limited"
  | "busy"
  | "offline"
  | "timeout"
  | "cancelled"
  | "bad_request"
  | "unexpected";

/** Why a call to the service did not work (Rust's `AiError`). */
export interface AiError {
  code: AiErrorCode;
  retryAfterSeconds?: number | null;
  status?: number;
}

export const OPENAI_PRESETS: readonly OpenAiPreset[] = [
  "openai",
  "gemini",
  "openrouter",
  "groq",
  "custom",
];

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** The key a connection's chosen model is saved under in preferences. */
export function targetKey(target: AiTarget): string {
  return target.provider === "anthropic" ? "anthropic" : `openai_compat:${target.preset}`;
}

export function isAiError(value: unknown): value is AiError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

export const aiConnections = {
  /** The browser build has no Credential Manager and no way to call out. */
  available: (): boolean => getBridge().mode === "tauri",
  /** Rejects with a code: `invalid_key`, `invalid_base_url`, or a store error. */
  setKey: (target: AiTarget, key: string, baseUrl: string | null): Promise<void> =>
    invoke<void>("ai_key_set", { target, key, baseUrl }),
  keyStatus: (target: AiTarget): Promise<KeyStatus> => invoke<KeyStatus>("ai_key_has", { target }),
  deleteKey: (target: AiTarget): Promise<void> => invoke<void>("ai_key_delete", { target }),
  /** The connection test. Rejects with an `AiError`. */
  listModels: (target: AiTarget): Promise<ModelInfo[]> =>
    invoke<ModelInfo[]>("ai_list_models", { target }),
  /** A text as Rust would send it, masked, and how many secrets went
      (the consent card). Nothing leaves the machine. */
  maskPreview: (text: string): Promise<MaskPreview> =>
    invoke<MaskPreview>("ai_mask_preview", { text }),
};

export interface MaskPreview {
  text: string;
  masked: number;
}
