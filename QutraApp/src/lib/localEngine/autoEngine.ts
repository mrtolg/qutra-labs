import { create } from "zustand";
import {
  ENGINE_TASK_EVENT,
  type EngineModel,
  type LocalEngineClient,
  LocalEngineCommandError,
  type LocalEngineError,
  type TaskEvent,
  localEngine,
} from "./client";

/* Making the local engine ready for a model without a manual step. Choosing
   a local model walks the same path the Settings strip offers button by
   button: fetch the engine if it is missing, make the text-only copy of the
   model if it needs one, start the engine with it. Rust still does every
   step and reports it on its events (the strip shows that progress); this
   only drives the order and keeps where it got to, and what went wrong, for
   the strip and the shell to show.

   At launch nothing is downloaded or copied: only a model that is already
   in place is started. A download or a copy begins when the user chose the
   model. */

export type AutoEnginePhase = "idle" | "installing" | "preparing" | "starting" | "ready" | "failed";

export interface AutoEngineState {
  phase: AutoEnginePhase;
  model: string | null;
  error: LocalEngineError | null;
}

const IDLE: AutoEngineState = { phase: "idle", model: null, error: null };

export const useAutoEngine = create<AutoEngineState>(() => IDLE);

/** The newest request; an older one that is still waiting stops reporting. */
let run = 0;

/** Forget what an automatic run reported (the user took a step by hand). */
export function clearAutoEngine(): void {
  run += 1;
  useAutoEngine.setState(IDLE);
}

export const resetAutoEngineForTesting = clearAutoEngine;

export interface EnsureOptions {
  /** The user chose this model (or switched the assistant on): fetch and
      prepare what is missing. False at launch: start only what is ready. */
  explicit: boolean;
  client?: LocalEngineClient;
}

function asError(caught: unknown): LocalEngineError {
  if (caught instanceof LocalEngineCommandError) return caught.error;
  if (caught && typeof caught === "object" && "code" in caught) return caught as LocalEngineError;
  return { code: "io" };
}

/** Start a background task and wait for Rust to say how it ended. */
async function runTask(
  client: LocalEngineClient,
  kind: TaskEvent["kind"],
  begin: () => Promise<unknown>,
  running: TaskEvent | null,
): Promise<void> {
  let settle: (task: TaskEvent) => void = () => {};
  const ended = new Promise<TaskEvent>((resolve) => (settle = resolve));
  // Listen before starting, so an end that comes at once is not missed.
  const unlisten = await client.listen<TaskEvent>(ENGINE_TASK_EVENT, (task) => {
    if (task.kind === kind && task.phase !== "running") settle(task);
  });
  try {
    // A task of this kind that is already under way is waited for, not started twice.
    if (!(running && running.kind === kind && running.phase === "running")) await begin();
    const task = await ended;
    if (task.phase === "failed") throw new LocalEngineCommandError(task.error ?? { code: "io" });
    if (task.phase === "cancelled") throw new LocalEngineCommandError({ code: "cancelled" });
  } finally {
    unlisten();
  }
}

function modelProblem(found: EngineModel | undefined): LocalEngineError | null {
  if (!found) return { code: "model_not_found" };
  if (found.state === "unsupported") {
    return { code: "model_unsupported", architecture: found.unsupportedArchitecture };
  }
  if (found.state === "unreadable") return { code: "model_unreadable" };
  return null;
}

/** Make the engine ready with `model`. Resolves when it is ready, stopped
    short (nothing to do at launch), or failed; the outcome is in the store. */
export async function ensureLocalEngine(
  model: string,
  { explicit, client = localEngine }: EnsureOptions,
): Promise<void> {
  if (!model || !client.available()) return;
  run += 1;
  const mine = run;
  const current = () => run === mine;
  const set = (state: Partial<AutoEngineState>) => {
    if (current()) useAutoEngine.setState({ model, error: null, ...state });
  };

  try {
    const report = await client.status();
    if (report.status.phase === "ready" && report.status.model === model) {
      set({ phase: "ready" });
      return;
    }

    if (!report.installed) {
      if (!explicit) return set({ phase: "idle", model: null });
      set({ phase: "installing" });
      await runTask(client, "install", () => client.install(), report.task);
      if (!current()) return;
    }

    let found = (await client.models()).models.find((m) => m.id === model);
    if (found?.state === "needs_prepare") {
      if (!explicit) return set({ phase: "idle", model: null });
      set({ phase: "preparing" });
      await runTask(client, "prepare", () => client.prepare(model), report.task);
      if (!current()) return;
      found = (await client.models()).models.find((m) => m.id === model);
    }
    const problem = modelProblem(found);
    if (problem) throw new LocalEngineCommandError(problem);

    set({ phase: "starting" });
    await client.start(model);
    set({ phase: "ready" });
  } catch (caught) {
    const error = asError(caught);
    if (error.code === "cancelled") set({ phase: "idle", model: null });
    else set({ phase: "failed", error });
  }
}
