import type { RunState } from "../lab";

/* ============================================================
   Tool-run state machine (pure). The native supervisor and the
   UI both drive runs through these transitions; invalid moves
   are rejected so a run's lifecycle stays auditable.
   ============================================================ */

const TRANSITIONS: Record<RunState, RunState[]> = {
  draft: ["validated", "blocked"],
  validated: ["queued", "draft", "blocked"],
  queued: ["starting", "cancelled", "blocked", "orphaned"],
  starting: ["running", "failed", "cancelled", "orphaned"],
  running: ["succeeded", "failed", "timed_out", "cancelling", "orphaned"],
  cancelling: ["cancelled", "failed"],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  blocked: ["draft", "validated"],
  orphaned: ["failed", "cancelled"],
};

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

/** States that represent an in-flight process on disk/OS. */
export const ACTIVE_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "queued",
  "starting",
  "running",
  "cancelling",
]);

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidRunTransition extends Error {
  constructor(from: RunState, to: RunState) {
    super(`Invalid run transition: ${from} → ${to}`);
    this.name = "InvalidRunTransition";
  }
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new InvalidRunTransition(from, to);
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Reconcile a run found active after an app restart: any in-flight state
 * becomes `orphaned` (the OS process no longer belongs to this process).
 * Terminal and already-orphaned runs are unchanged.
 */
export function reconcileOnRestart(state: RunState): RunState {
  return ACTIVE_STATES.has(state) ? "orphaned" : state;
}
