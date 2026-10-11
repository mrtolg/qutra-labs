import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENGINE_TASK_EVENT,
  type EngineModel,
  type EngineReport,
  type LocalEngineClient,
  LocalEngineCommandError,
  type TaskEvent,
} from "./client";
import { ensureLocalEngine, resetAutoEngineForTesting, useAutoEngine } from "./autoEngine";

const stopped = {
  phase: "stopped",
  model: null,
  endpoint: null,
  error: null,
  idleMinutes: 5,
  build: "b1",
} as const;

const report = (over: Partial<EngineReport> = {}): EngineReport => ({
  status: stopped,
  installed: true,
  build: "b1",
  commit: "c",
  downloadSource: "github.com/ggml-org/llama.cpp",
  downloadBytes: 1,
  task: null,
  ...over,
});

const model = (over: Record<string, unknown> = {}): EngineModel =>
  ({
    id: "gemma4:26b",
    name: "gemma4:26b",
    source: "ollama",
    sizeBytes: 1,
    architecture: "gemma4",
    tools: null,
    prepared: false,
    state: "ready",
    ...over,
  }) as EngineModel;

const needsPrepare = () => model({ state: "needs_prepare", writeBytes: 5 });

/** A fake client. Tasks finish when the test says so, as Rust's events would. */
function fake(opts: { report?: EngineReport; models?: EngineModel[] } = {}) {
  let handler: ((task: TaskEvent) => void) | null = null;
  let models = opts.models ?? [model()];
  const calls: string[] = [];
  const client = {
    available: () => true,
    status: vi.fn(async () => opts.report ?? report()),
    models: vi.fn(async () => ({ models, ollamaStore: true, freeBytes: null })),
    install: vi.fn(async () => {
      calls.push("install");
      return {} as TaskEvent;
    }),
    prepare: vi.fn(async (id: string) => {
      calls.push(`prepare:${id}`);
      return {} as TaskEvent;
    }),
    start: vi.fn(async (id: string) => {
      calls.push(`start:${id}`);
      return stopped;
    }),
    listen: vi.fn(async (event: string, h: (task: TaskEvent) => void) => {
      if (event === ENGINE_TASK_EVENT) handler = h;
      return () => {
        handler = null;
      };
    }),
  } as unknown as LocalEngineClient;
  const finish = (task: Partial<TaskEvent>) =>
    handler?.({
      kind: "install",
      phase: "done",
      model: null,
      doneBytes: 1,
      totalBytes: 1,
      error: null,
      ...task,
    });
  return { client, calls, finish, setModels: (next: EngineModel[]) => (models = next) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => resetAutoEngineForTesting());

describe("the local engine, made ready without a manual step", () => {
  it("starts an installed engine with a ready model", async () => {
    const { client, calls } = fake();
    await ensureLocalEngine("gemma4:26b", { explicit: true, client });

    expect(calls).toEqual(["start:gemma4:26b"]);
    expect(useAutoEngine.getState()).toMatchObject({ phase: "ready", model: "gemma4:26b", error: null });
  });

  it("installs a missing engine, prepares the model, then starts it, saying each step", async () => {
    const f = fake({ report: report({ installed: false }), models: [needsPrepare()] });
    const done = ensureLocalEngine("gemma4:26b", { explicit: true, client: f.client });

    await tick();
    expect(useAutoEngine.getState().phase).toBe("installing");
    f.finish({ kind: "install", phase: "done" });
    await tick();
    expect(useAutoEngine.getState().phase).toBe("preparing");
    f.setModels([model({ prepared: true })]);
    f.finish({ kind: "prepare", phase: "done", model: "gemma4:26b" });
    await done;

    expect(f.calls).toEqual(["install", "prepare:gemma4:26b", "start:gemma4:26b"]);
    expect(useAutoEngine.getState().phase).toBe("ready");
  });

  it("at launch starts only what is already in place, and downloads nothing", async () => {
    const missing = fake({ report: report({ installed: false }) });
    await ensureLocalEngine("gemma4:26b", { explicit: false, client: missing.client });
    expect(missing.calls).toEqual([]);
    expect(useAutoEngine.getState().phase).toBe("idle");

    const unprepared = fake({ models: [needsPrepare()] });
    await ensureLocalEngine("gemma4:26b", { explicit: false, client: unprepared.client });
    expect(unprepared.calls).toEqual([]);
    expect(useAutoEngine.getState().phase).toBe("idle");

    const ready = fake();
    await ensureLocalEngine("gemma4:26b", { explicit: false, client: ready.client });
    expect(ready.calls).toEqual(["start:gemma4:26b"]);
  });

  it("leaves a model that is already running alone", async () => {
    const f = fake({
      report: report({ status: { ...stopped, phase: "ready", model: "gemma4:26b" } }),
    });
    await ensureLocalEngine("gemma4:26b", { explicit: true, client: f.client });

    expect(f.calls).toEqual([]);
    expect(useAutoEngine.getState().phase).toBe("ready");
  });

  it("reports why when the engine cannot start", async () => {
    const f = fake();
    (f.client.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new LocalEngineCommandError({ code: "load_failed", reason: "out_of_memory" }),
    );
    await ensureLocalEngine("gemma4:26b", { explicit: true, client: f.client });

    expect(useAutoEngine.getState()).toMatchObject({
      phase: "failed",
      error: { code: "load_failed", reason: "out_of_memory" },
    });
  });

  it("reports a failed download and does not go on to the model", async () => {
    const f = fake({ report: report({ installed: false }) });
    const done = ensureLocalEngine("gemma4:26b", { explicit: true, client: f.client });
    await tick();
    f.finish({ kind: "install", phase: "failed", error: { code: "download_failed" } });
    await done;

    expect(useAutoEngine.getState()).toMatchObject({ phase: "failed", error: { code: "download_failed" } });
    expect(f.calls).toEqual(["install"]);
  });

  it("names a model the engine does not have, and one it cannot run", async () => {
    const none = fake({ models: [] });
    await ensureLocalEngine("gemma4:26b", { explicit: true, client: none.client });
    expect(useAutoEngine.getState().error).toEqual({ code: "model_not_found" });

    const odd = fake({ models: [model({ state: "unsupported", unsupportedArchitecture: "mamba" })] });
    await ensureLocalEngine("gemma4:26b", { explicit: true, client: odd.client });
    expect(useAutoEngine.getState().error).toEqual({ code: "model_unsupported", architecture: "mamba" });
  });

  it("a cancelled step is not an error", async () => {
    const f = fake({ report: report({ installed: false }) });
    const done = ensureLocalEngine("gemma4:26b", { explicit: true, client: f.client });
    await tick();
    f.finish({ kind: "install", phase: "cancelled" });
    await done;

    expect(useAutoEngine.getState()).toMatchObject({ phase: "idle", error: null });
  });

  it("only the newest choice reports: an older run that finishes late is dropped", async () => {
    const slow = fake({ report: report({ installed: false }) });
    const first = ensureLocalEngine("gemma4:26b", { explicit: true, client: slow.client });
    await tick();
    const quick = fake({ models: [model({ id: "qwen2.5:7b", name: "qwen2.5:7b" })] });
    await ensureLocalEngine("qwen2.5:7b", { explicit: true, client: quick.client });
    slow.finish({ kind: "install", phase: "done" });
    await first;

    expect(quick.calls).toEqual(["start:qwen2.5:7b"]);
    expect(slow.calls).toEqual(["install"]);
    expect(useAutoEngine.getState()).toMatchObject({ phase: "ready", model: "qwen2.5:7b" });
  });

  it("does nothing outside the desktop app", async () => {
    const f = fake();
    (f.client as unknown as { available: () => boolean }).available = () => false;
    await ensureLocalEngine("gemma4:26b", { explicit: true, client: f.client });

    expect(f.client.status).not.toHaveBeenCalled();
    expect(useAutoEngine.getState().phase).toBe("idle");
  });
});
