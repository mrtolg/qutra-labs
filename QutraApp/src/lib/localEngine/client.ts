import { isTauriRuntime } from "@/lib/runtime";

/* ============================================================
   Qutra's local engine (ADR 0016), as the page sees it.

   Rust owns everything that matters: which llama.cpp build runs, where it
   listens, which file a model id names, and when the engine stops. This
   client only asks, by model id, and listens. No command here takes a path,
   a port, a flag or an address.
   ============================================================ */

export type EnginePhase = "stopped" | "starting" | "loading" | "ready" | "failed";

export type LocalEngineError =
  | { code: "engine_missing" }
  | { code: "engine_corrupt" }
  | { code: "download_failed" }
  | { code: "download_hash_mismatch" }
  | { code: "unpack_failed" }
  | { code: "model_not_found" }
  | { code: "model_needs_prepare" }
  | { code: "model_unsupported"; architecture: string }
  | { code: "model_unreadable" }
  | { code: "not_enough_disk"; needed: number; free: number }
  | { code: "start_failed" }
  | { code: "load_failed"; reason: string }
  | { code: "load_timeout" }
  | { code: "busy" }
  | { code: "cancelled" }
  | { code: "io" };

export interface EngineStatus {
  phase: EnginePhase;
  model: string | null;
  endpoint: string | null;
  error: LocalEngineError | null;
  idleMinutes: number;
  build: string;
}

export interface TaskEvent {
  kind: "install" | "prepare";
  phase: "running" | "done" | "failed" | "cancelled";
  model: string | null;
  doneBytes: number;
  totalBytes: number;
  error: LocalEngineError | null;
}

export interface EngineReport {
  status: EngineStatus;
  installed: boolean;
  build: string;
  commit: string;
  downloadSource: string;
  downloadBytes: number;
  task: TaskEvent | null;
}

export type ModelState =
  | { state: "ready" }
  | { state: "needs_prepare"; writeBytes: number }
  | { state: "unsupported"; unsupportedArchitecture: string }
  | { state: "unreadable"; reason: string };

export type EngineModel = {
  id: string;
  name: string;
  source: "ollama" | "folder";
  sizeBytes: number;
  architecture: string | null;
  tools: boolean | null;
  prepared: boolean;
} & ModelState;

export interface ModelsReport {
  models: EngineModel[];
  ollamaStore: boolean;
  freeBytes: number | null;
}

export const ENGINE_STATUS_EVENT = "local-engine://status";
export const ENGINE_TASK_EVENT = "local-engine://task";

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type ListenFn = <T>(event: string, handler: (payload: T) => void) => Promise<() => void>;

export interface LocalEngineClientOptions {
  invokeImpl?: InvokeFn;
  listenImpl?: ListenFn;
  availableImpl?: () => boolean;
}

/** A command refused; carries Rust's typed error. */
export class LocalEngineCommandError extends Error {
  constructor(readonly error: LocalEngineError) {
    super(`local_engine:${error.code}`);
    this.name = "LocalEngineCommandError";
  }
}

function asEngineError(caught: unknown): LocalEngineCommandError {
  if (caught instanceof LocalEngineCommandError) return caught;
  if (caught && typeof caught === "object" && "code" in caught) {
    return new LocalEngineCommandError(caught as LocalEngineError);
  }
  return new LocalEngineCommandError({ code: "io" });
}

export class LocalEngineClient {
  private readonly invokeImpl?: InvokeFn;
  private readonly listenImpl?: ListenFn;
  private readonly availableImpl: () => boolean;

  constructor(options: LocalEngineClientOptions = {}) {
    this.invokeImpl = options.invokeImpl;
    this.listenImpl = options.listenImpl;
    this.availableImpl = options.availableImpl ?? isTauriRuntime;
  }

  available(): boolean {
    return this.availableImpl();
  }

  private async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.available()) throw new LocalEngineCommandError({ code: "io" });
    try {
      if (this.invokeImpl) return await this.invokeImpl<T>(command, args);
      // Lazily, so a browser build never pulls the Tauri API in.
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<T>(command, args);
    } catch (caught) {
      throw asEngineError(caught);
    }
  }

  async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    if (!this.available()) return () => {};
    if (this.listenImpl) return this.listenImpl<T>(event, handler);
    const { listen } = await import("@tauri-apps/api/event");
    return listen<T>(event, (e) => handler(e.payload));
  }

  status(): Promise<EngineReport> {
    return this.invoke<EngineReport>("local_engine_status");
  }

  models(): Promise<ModelsReport> {
    return this.invoke<ModelsReport>("local_models_list");
  }

  start(model: string): Promise<EngineStatus> {
    return this.invoke<EngineStatus>("local_engine_start", { model });
  }

  stop(): Promise<EngineStatus> {
    return this.invoke<EngineStatus>("local_engine_stop");
  }

  setIdleMinutes(minutes: number): Promise<EngineStatus> {
    return this.invoke<EngineStatus>("local_engine_set_idle", { minutes });
  }

  /** The one-time download of the pinned build. Progress arrives as task events. */
  install(): Promise<TaskEvent> {
    return this.invoke<TaskEvent>("local_engine_install");
  }

  /** The one-time text-only copy of an Ollama model that needs it. */
  prepare(model: string): Promise<TaskEvent> {
    return this.invoke<TaskEvent>("local_model_prepare", { model });
  }

  cancelTask(): Promise<boolean> {
    return this.invoke<boolean>("local_task_cancel");
  }

  /** `confirmed` is the user's answer to the confirmation; Rust refuses without it. */
  deleteCopy(model: string, confirmed: boolean): Promise<void> {
    return this.invoke<void>("local_model_delete_copy", { model, confirmed });
  }

  openModelsFolder(): Promise<void> {
    return this.invoke<void>("local_models_open_folder");
  }
}

/** Shared instance; tests construct their own with mocks. */
export const localEngine = new LocalEngineClient();

/** Bytes as Windows Explorer shows them (1024-based): "16,8 GB", in the
    reader's locale. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit >= 3 && value < 100 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}
