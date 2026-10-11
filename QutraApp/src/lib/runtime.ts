/**
 * Single source of truth for which runtime we are in.
 *
 * The Tauri v2 WebView injects `__TAURI_INTERNALS__`. This is checked once
 * and drives both storage backend and bridge selection, so the two can
 * never disagree (browser storage with a native bridge, or vice-versa).
 */
export type Runtime = "tauri" | "browser";

let cached: Runtime | null = null;

export function detectRuntime(): Runtime {
  if (cached) return cached;
  const isTauri =
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
  cached = isTauri ? "tauri" : "browser";
  return cached;
}

export const isTauriRuntime = () => detectRuntime() === "tauri";

/** Test seam. */
export function setRuntimeForTesting(runtime: Runtime | null): void {
  cached = runtime;
}
