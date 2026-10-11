import { getBridge } from "@/lib/bridge";
import { isTauriRuntime } from "@/lib/runtime";

export interface AbandonPreviousRendererResult {
  cancelledTurn: boolean;
  closedSessions: number;
}

/**
 * Tell Rust to invalidate and close work owned by this renderer: cancel
 * the assistant turn, `terminal_close_all`, forget agent sessions.
 *
 * Used on renderer load and on orderly shutdown (`pagehide`). Not two
 * primitives.
 *
 * Crash-without-reload is uncovered: if this webview dies and never
 * fires `pagehide` or boots again, the broker turn lives until
 * TURN_TIMEOUT and PTYs live until process exit. That gap is accepted.
 * Job Objects are out of scope.
 */
export async function abandonPreviousRendererWork(): Promise<AbandonPreviousRendererResult> {
  if (!isTauriRuntime()) {
    return { cancelledTurn: false, closedSessions: 0 };
  }
  return getBridge().abandonPreviousRenderer();
}

/** Orderly shutdown: reuse `abandonPreviousRendererWork`, do not add a
 * second native cleanup path. */
export function installRendererShutdown(): () => void {
  const onPageHide = () => {
    void abandonPreviousRendererWork().catch(() => {});
  };
  window.addEventListener("pagehide", onPageHide);
  return () => window.removeEventListener("pagehide", onPageHide);
}
