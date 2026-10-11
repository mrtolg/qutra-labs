import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  ENGINE_STATUS_EVENT,
  ENGINE_TASK_EVENT,
  type EngineModel,
  type EngineReport,
  type EngineStatus,
  type LocalEngineClient,
  LocalEngineCommandError,
  type ModelsReport,
  type TaskEvent,
} from "@/lib/localEngine/client";
import { LocalEnginePanel } from "./LocalEnginePanel";

const GB = 1024 ** 3;

function seedDb(prefs: Record<string, unknown> = {}) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ localAssistantEnabled: true, ollamaModel: "gemma4:26b", ...prefs });
  setDbForTesting(db);
}

afterEach(() => {
  setDbForTesting(null);
  vi.clearAllMocks();
});

const stopped: EngineStatus = {
  phase: "stopped",
  model: null,
  endpoint: null,
  error: null,
  idleMinutes: 5,
  build: "b11541",
};

function report(over: Partial<EngineReport> = {}): EngineReport {
  return {
    status: stopped,
    installed: true,
    build: "b11541",
    commit: "f2918cabb",
    downloadSource: "github.com/ggml-org/llama.cpp",
    downloadBytes: 33_464_528,
    task: null,
    ...over,
  };
}

const gemma: EngineModel = {
  id: "gemma4:26b",
  name: "gemma4:26b",
  source: "ollama",
  sizeBytes: 17_987_569_344,
  architecture: "gemma4",
  tools: null,
  prepared: false,
  state: "needs_prepare",
  writeBytes: 16_778_706_880,
};
const qwen: EngineModel = {
  id: "qwen2.5:7b",
  name: "qwen2.5:7b",
  source: "ollama",
  sizeBytes: 4_683_073_952,
  architecture: "qwen2",
  tools: true,
  prepared: false,
  state: "ready",
};

/** A client whose answers each test sets, and whose events it can fire. */
function fakeClient(engine: EngineReport, models: EngineModel[], freeBytes = 90 * GB) {
  const handlers = new Map<string, (payload: unknown) => void>();
  const modelsReport: ModelsReport = { models, ollamaStore: true, freeBytes };
  const client = {
    available: vi.fn(() => true),
    status: vi.fn(async () => engine),
    models: vi.fn(async () => modelsReport),
    listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    start: vi.fn(async () => ({ ...stopped, phase: "ready" })),
    stop: vi.fn(async () => stopped),
    install: vi.fn(async () => ({}) as TaskEvent),
    prepare: vi.fn(async () => ({}) as TaskEvent),
    cancelTask: vi.fn(async () => true),
    deleteCopy: vi.fn(async () => undefined),
    openModelsFolder: vi.fn(async () => undefined),
    setIdleMinutes: vi.fn(),
  };
  const emit = (event: string, payload: unknown) => act(() => handlers.get(event)?.(payload));
  return { client: client as unknown as LocalEngineClient, mock: client, emit };
}

describe("LocalEnginePanel", () => {
  it("asks for the one-time engine download and says from where and how big", async () => {
    seedDb();
    const { client, mock } = fakeClient(report({ installed: false }), [gemma]);
    render(<LocalEnginePanel client={client} />);

    expect(await screen.findByText("The local engine needs a one-time download")).toBeInTheDocument();
    expect(screen.getByText(/github\.com\/ggml-org\/llama\.cpp, build b11541/)).toBeInTheDocument();
    expect(screen.getByTestId("le-station-engine")).toHaveAttribute("data-state", "attention");
    fireEvent.click(screen.getByTestId("local-engine-install"));
    expect(mock.install).toHaveBeenCalledTimes(1);
  });

  it("follows a download with a progress bar that can be cancelled", async () => {
    seedDb();
    const task: TaskEvent = {
      kind: "install",
      phase: "running",
      model: null,
      doneBytes: 16_732_264,
      totalBytes: 33_464_528,
      error: null,
    };
    const { client, mock } = fakeClient(report({ installed: false, task }), [gemma]);
    render(<LocalEnginePanel client={client} />);

    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByTestId("le-station-engine")).toHaveAttribute("data-state", "active");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mock.cancelTask).toHaveBeenCalledTimes(1);
  });

  it("explains the one-time copy of an Ollama model and what it writes", async () => {
    seedDb();
    const { client, mock } = fakeClient(report(), [gemma, qwen]);
    render(<LocalEnginePanel client={client} />);

    expect(await screen.findByText("gemma4:26b needs a one-time copy")).toBeInTheDocument();
    expect(screen.getByText(/Ollama's file is not touched/)).toBeInTheDocument();
    expect(screen.getByText(/Writes 15,6 GB|Writes 15.6 GB/)).toBeInTheDocument();
    expect(screen.getByTestId("le-station-model")).toHaveAttribute("data-state", "attention");
    fireEvent.click(screen.getByTestId("local-engine-prepare"));
    expect(mock.prepare).toHaveBeenCalledWith("gemma4:26b");
  });

  it("says plainly when the disk is too full for the copy", async () => {
    seedDb();
    const { client, mock } = fakeClient(report(), [gemma]);
    mock.prepare.mockRejectedValue(
      new LocalEngineCommandError({ code: "not_enough_disk", needed: 18 * GB, free: 5 * GB }),
    );
    render(<LocalEnginePanel client={client} />);

    fireEvent.click(await screen.findByTestId("local-engine-prepare"));
    expect(await screen.findByTestId("local-engine-error")).toHaveTextContent(
      "Not enough free space: 18 GB needed, 5 GB free.",
    );
  });

  it("shows a ready engine with its idle stop, and stops it on request", async () => {
    seedDb({ ollamaModel: "qwen2.5:7b" });
    const ready: EngineStatus = {
      ...stopped,
      phase: "ready",
      model: "qwen2.5:7b",
      endpoint: "http://127.0.0.1:50123",
    };
    const { client, mock } = fakeClient(report({ status: ready }), [gemma, qwen]);
    render(<LocalEnginePanel client={client} />);

    expect(await screen.findByTestId("local-engine-step")).toHaveTextContent(
      "qwen2.5:7b is ready · stops after 5 idle minutes",
    );
    expect(screen.getByTestId("le-station-answer")).toHaveAttribute("data-state", "done");
    fireEvent.click(screen.getByTestId("local-engine-stop"));
    expect(mock.stop).toHaveBeenCalledTimes(1);
  });

  it("hears the engine load the model as it happens", async () => {
    seedDb({ ollamaModel: "qwen2.5:7b" });
    const { client, emit } = fakeClient(report(), [qwen]);
    render(<LocalEnginePanel client={client} />);
    expect(await screen.findByTestId("local-engine-step")).toHaveTextContent(/starts by itself/);

    emit(ENGINE_STATUS_EVENT, { ...stopped, phase: "loading", model: "qwen2.5:7b" });
    expect(screen.getByTestId("local-engine-step")).toHaveTextContent("Loading qwen2.5:7b into memory…");
    expect(screen.getByTestId("le-station-answer")).toHaveAttribute("data-state", "active");
  });

  it("reads everything again when a task ends", async () => {
    seedDb();
    const onChanged = vi.fn();
    const { client, mock, emit } = fakeClient(report(), [gemma]);
    render(<LocalEnginePanel client={client} onChanged={onChanged} />);
    await screen.findByTestId("local-engine-prepare");
    expect(mock.models).toHaveBeenCalledTimes(1);

    emit(ENGINE_TASK_EVENT, {
      kind: "prepare",
      phase: "done",
      model: "gemma4:26b",
      doneBytes: 1,
      totalBytes: 1,
      error: null,
    });
    await waitFor(() => expect(mock.models).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalled();
  });

  it("chooses another model from the list", async () => {
    seedDb();
    const { client } = fakeClient(report(), [gemma, qwen]);
    render(<LocalEnginePanel client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Use: qwen2.5:7b" }));
    expect(getDb().prefs.get().ollamaModel).toBe("qwen2.5:7b");
  });

  it("deletes a prepared copy only after the user confirms", async () => {
    seedDb();
    const prepared: EngineModel = { ...gemma, state: "ready", prepared: true, tools: true };
    const { client, mock } = fakeClient(report(), [prepared]);
    render(<LocalEnginePanel client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete the copy: gemma4:26b" }));
    expect(screen.getByText(/The model stays in Ollama/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mock.deleteCopy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete the copy: gemma4:26b" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Delete the copy")!,
    );
    await waitFor(() => expect(mock.deleteCopy).toHaveBeenCalledWith("gemma4:26b", true));
  });

  it("names a missing model and offers the models that exist", async () => {
    seedDb({ ollamaModel: "gone:1b" });
    const { client } = fakeClient(report(), [qwen]);
    render(<LocalEnginePanel compact client={client} />);

    expect(await screen.findByTestId("local-engine-step")).toHaveTextContent("gone:1b wasn't found.");
    expect(screen.getByTestId("local-engine-models")).toBeInTheDocument();
  });

  it("asks nothing while Jarvis is off or outside the desktop app", () => {
    seedDb({ localAssistantEnabled: false });
    const { client, mock } = fakeClient(report(), [qwen]);
    const { container } = render(<LocalEnginePanel client={client} />);
    expect(container).toBeEmptyDOMElement();
    expect(mock.status).not.toHaveBeenCalled();

    seedDb();
    mock.available.mockReturnValue(false);
    const second = render(<LocalEnginePanel client={client} />);
    expect(second.container).toBeEmptyDOMElement();
    expect(mock.status).not.toHaveBeenCalled();
  });
});
