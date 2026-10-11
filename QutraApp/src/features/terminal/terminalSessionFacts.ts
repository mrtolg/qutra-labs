import { create } from "zustand";
import type {
  TerminalController,
  TerminalSessionEvent,
  TerminalSessionInfo,
  TerminalSessionList,
} from "@/lib/bridge/terminal";

/**
 * The renderer's copy of Rust's session facts. Rust owns them; this
 * store only mirrors `terminal_list_sessions` plus the `terminal://session`
 * events after it, so the Work status strip, the rail and Home read one
 * snapshot instead of each asking Rust. Nothing here may start or stop a
 * process -- tabs still own their sessions.
 */
export interface TerminalSessionFacts {
  /** `null` until the first list arrives. */
  runtimeId: string | null;
  /** Highest revision applied; events at or below it are already covered. */
  revision: number;
  byId: Record<string, TerminalSessionInfo>;
  /**
   * Whether `byId` is Rust's current word. "connecting" before the first
   * list; "reconciling" from an event of another native runtime until a fresh
   * list arrives; "unavailable" when a list failed (a retry is scheduled).
   * Only "live" facts count as running processes: see `liveSessions`.
   */
  status: "connecting" | "live" | "reconciling" | "unavailable";
}

/** How many ended sessions to keep for display. A closed session leaves
 * Rust's registry but its exit event still arrives here; without a bound,
 * every session a long-lived window ever closed would stay in memory.
 * Running sessions are never dropped. */
export const ENDED_SESSIONS_KEPT = 50;

export const emptyFacts: TerminalSessionFacts = {
  runtimeId: null,
  revision: 0,
  byId: {},
  status: "connecting",
};

/** How long to wait after each failed list before asking again; the last
 * delay repeats until a list succeeds. */
export const LIST_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000, 30_000];

function isEnded(s: TerminalSessionInfo): boolean {
  return s.state === "exited" || s.state === "unknown";
}

function boundEnded(byId: Record<string, TerminalSessionInfo>): Record<string, TerminalSessionInfo> {
  const ended = Object.values(byId).filter(isEnded);
  if (ended.length <= ENDED_SESSIONS_KEPT) return byId;
  const drop = ended
    .sort((a, b) => a.revision - b.revision)
    .slice(0, ended.length - ENDED_SESSIONS_KEPT);
  const next = { ...byId };
  for (const s of drop) delete next[s.sessionId];
  return next;
}

/** A list is the whole truth as of its revision. */
export function applyList(list: TerminalSessionList): TerminalSessionFacts {
  const byId: Record<string, TerminalSessionInfo> = {};
  for (const s of list.sessions) byId[s.sessionId] = s;
  return { runtimeId: list.runtimeId, revision: list.revision, byId, status: "live" };
}

/** Sessions Rust reports as not ended. None while the facts are not live:
 * after a runtime change or a failed list, the old records are history. */
export function liveSessions(facts: TerminalSessionFacts): TerminalSessionInfo[] {
  if (facts.status !== "live") return [];
  return Object.values(facts.byId).filter((s) => !isEnded(s));
}

/** Apply one event. `"resync"` means the event came from a different native
 * runtime than the snapshot, so the snapshot can no longer be trusted. */
export function applyEvent(
  facts: TerminalSessionFacts,
  event: TerminalSessionEvent,
): TerminalSessionFacts | "resync" {
  if (event.runtimeId !== facts.runtimeId) return "resync";
  if (event.revision <= facts.revision) return facts;
  return {
    runtimeId: facts.runtimeId,
    revision: event.revision,
    byId: boundEnded({ ...facts.byId, [event.session.sessionId]: event.session }),
    status: facts.status,
  };
}

export const useTerminalSessionFacts = create<TerminalSessionFacts>(() => emptyFacts);

export interface ConnectOptions {
  /** Aborting stops the connection at once, even while its first list is in
   * flight: nothing is published after that, so a connector left over from
   * an unmounted surface cannot overwrite a newer one. */
  signal?: AbortSignal;
  /** Overrides LIST_RETRY_DELAYS_MS (tests). */
  retryDelaysMs?: readonly number[];
}

/**
 * Subscribe, then list, then apply only newer events -- the order that
 * guarantees no change falls between the snapshot and the stream. Events
 * that arrive while a list is in flight are held and replayed
 * after it. A failed list leaves the facts "unavailable" and is retried on a
 * timer, so recovery never waits for another session event. Resolves to a
 * disposer that stops listening.
 */
export async function connectTerminalSessionFacts(
  terminal: TerminalController,
  options: ConnectOptions = {},
): Promise<() => void> {
  const { signal, retryDelaysMs = LIST_RETRY_DELAYS_MS } = options;
  let disposed = false;
  let pending: TerminalSessionEvent[] | null = [];
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // Filled once onSession resolves; dispose may run before that.
  const subscription: { off?: () => void } = {};

  const alive = () => !disposed && !signal?.aborted;
  const set = (facts: TerminalSessionFacts) => {
    if (alive()) useTerminalSessionFacts.setState(facts, true);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(retryTimer);
    subscription.off?.();
  };
  signal?.addEventListener("abort", dispose, { once: true });

  const scheduleRetry = () => {
    if (!alive()) return;
    const delay = retryDelaysMs[Math.min(failures, retryDelaysMs.length - 1)];
    failures += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void reconcile(), delay);
  };

  const reconcile = async (): Promise<void> => {
    clearTimeout(retryTimer);
    pending = [];
    let list: TerminalSessionList;
    try {
      list = await terminal.listSessions();
    } catch (err) {
      // Stop holding events, or the stream stalls for good. The old records
      // stay as history; nothing counts them as running while unavailable.
      pending = null;
      if (!alive()) return;
      console.warn("terminal_list_sessions failed:", err);
      set({ ...useTerminalSessionFacts.getState(), status: "unavailable" });
      scheduleRetry();
      return;
    }
    if (!alive()) return;
    let facts = applyList(list);
    const held = pending;
    pending = null;
    for (const e of held) {
      const next = applyEvent(facts, e);
      // A second runtime change while listing: the list we just took is
      // already stale, so take another.
      if (next === "resync") return reconcile();
      facts = next;
    }
    failures = 0;
    set(facts);
  };

  const unsubscribe = await terminal.onSession((event) => {
    if (!alive()) return;
    if (pending) {
      pending.push(event);
      return;
    }
    const current = useTerminalSessionFacts.getState();
    const next = applyEvent(current, event);
    if (next === "resync") {
      // Rust's runtime changed underneath us: what we hold no longer
      // describes running processes. Say so now, then take a fresh list.
      set({ ...current, status: "reconciling" });
      void reconcile();
      return;
    }
    set(next);
  });
  subscription.off = unsubscribe;
  if (!alive()) {
    // Aborted while subscribing.
    unsubscribe();
    return dispose;
  }

  await reconcile();
  return dispose;
}
