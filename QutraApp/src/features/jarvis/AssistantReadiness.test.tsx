import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { localAssistant } from "@/lib/localAssistant/client";
import {
  type EngineModel,
  type EngineReport,
  type EngineStatus,
  localEngine,
} from "@/lib/localEngine/client";
import { AssistantReadiness } from "./AssistantReadiness";

/* The readiness card on Qutra's own local engine (ADR 0016). Jarvis no longer
   waits for Ollama: the card names the engine, the model and the answer, and
   offers the one step that stands in the way (download the engine once,
   prepare the model once, pick another). It never hands the user a command
   to paste. */

vi.mock("@/lib/localAssistant/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/localAssistant/client")>();
  return {
    ...actual,
    localAssistant: {
      available: vi.fn().mockReturnValue(true),
      checkHealth: vi.fn(),
      listModels: vi.fn(),
      streamChat: vi.fn(),
      approveTool: vi.fn(),
    },
  };
});

vi.mock("@/lib/localEngine/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/localEngine/client")>();
  return {
    ...actual,
    localEngine: {
      available: vi.fn(),
      status: vi.fn(),
      models: vi.fn(),
      listen: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      install: vi.fn(),
      prepare: vi.fn(),
      cancelTask: vi.fn(),
      deleteCopy: vi.fn(),
      openModelsFolder: vi.fn(),
      setIdleMinutes: vi.fn(),
    },
  };
});

const available = vi.mocked(localAssistant.available);
const listModels = vi.mocked(localAssistant.listModels);
const engine = vi.mocked(localEngine);

const stopped: EngineStatus = {
  phase: "stopped",
  model: null,
  endpoint: null,
  error: null,
  idleMinutes: 5,
  build: "b11541",
};

function engineReport(over: Partial<EngineReport> = {}): EngineReport {
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

function model(id: string, over: Partial<EngineModel> = {}): EngineModel {
  return {
    id,
    name: id,
    source: "ollama",
    sizeBytes: 4_683_073_952,
    architecture: "qwen2",
    tools: true,
    prepared: false,
    state: "ready",
    ...over,
  } as EngineModel;
}

/** What Rust found on disk, for the engine strip inside the card. */
function engineFinds(report: EngineReport, models: EngineModel[]) {
  engine.status.mockResolvedValue(report);
  engine.models.mockResolvedValue({ models, ollamaStore: true, freeBytes: 90 * 1024 ** 3 });
}

function seedDb(prefs: Record<string, unknown> = {}) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({
    localAssistantEnabled: true,
    ollamaModel: "qwen2.5:14b",
    ...prefs,
  });
  setDbForTesting(db);
  return db;
}

/** No pasteable command anywhere on the card, whatever the model is called. */
function expectNoCommand(container: HTMLElement) {
  expect(container.textContent).not.toMatch(/ollama (serve|pull)/i);
  expect(screen.queryByTestId("readiness-start-command")).toBeNull();
  expect(screen.queryByTestId("readiness-pull-command")).toBeNull();
  expect(screen.queryByRole("button", { name: /^copy$/i })).toBeNull();
}

beforeEach(() => {
  available.mockReturnValue(true);
  engine.available.mockReturnValue(true);
  engine.listen.mockResolvedValue(() => {});
  engineFinds(engineReport(), [model("qwen2.5:14b")]);
});

afterEach(() => {
  setDbForTesting(null);
  vi.clearAllMocks();
});

describe("AssistantReadiness", () => {
  it("states browser mode once and offers neither a command nor the engine strip", () => {
    seedDb();
    available.mockReturnValue(false);
    engine.available.mockReturnValue(false);
    const { container } = render(
      <AssistantReadiness
        health={{ status: "unavailable", models: [], detail: "no_native_runtime" }}
        checking={false}
      />,
    );

    expect(screen.getByTestId("readiness-browser")).toHaveTextContent(/browser version can't reach it/i);
    expect(screen.queryByTestId("local-engine-panel")).toBeNull();
    expectNoCommand(container);
  });

  it("still offers Test connection in the browser so the missing broker is discovered", () => {
    seedDb();
    available.mockReturnValue(false);
    const onCheck = vi.fn();
    render(
      <AssistantReadiness
        health={null}
        checking={false}
        onCheck={onCheck}
        showCheckButton
      />,
    );

    expect(screen.getByTestId("local-assistant-test-connection")).toBeInTheDocument();
  });

  it("asks nothing while the assistant is off, and says how to turn it on", () => {
    seedDb({ localAssistantEnabled: false });
    const { container } = render(<AssistantReadiness health={null} checking={false} />);

    expect(localAssistant.checkHealth).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    expect(engine.status).not.toHaveBeenCalled();
    expect(engine.models).not.toHaveBeenCalled();
    expect(screen.getByTestId("local-assistant-status")).toHaveTextContent("Off");
    expect(screen.getByTestId("readiness-start")).toHaveTextContent(/Turn on Jarvis/);
    expect(screen.queryByTestId("local-engine-panel")).toBeNull();
    expectNoCommand(container);
  });

  it("names an engine that is not installed and offers its one-time download, not a command", async () => {
    seedDb();
    engineFinds(engineReport({ installed: false }), [model("qwen2.5:14b")]);
    const { container } = render(
      <AssistantReadiness
        health={{ status: "engine_missing", models: ["qwen2.5:14b"], selectedModel: "qwen2.5:14b" }}
        checking={false}
      />,
    );

    expect(screen.getByTestId("local-assistant-status")).toHaveTextContent("Local engine not installed");
    expect(await screen.findByTestId("local-engine-install")).toHaveTextContent(/Download the engine/);
    expect(screen.getByTestId("le-station-engine")).toHaveAttribute("data-state", "attention");
    expect(listModels).not.toHaveBeenCalled();
    expectNoCommand(container);
  });

  it("leads a model that needs its one-time copy to the prepare step", async () => {
    seedDb({ ollamaModel: "gemma4:26b" });
    engineFinds(engineReport(), [
      model("gemma4:26b", { architecture: "gemma4", tools: null, state: "needs_prepare", writeBytes: 16_778_706_880 }),
    ]);
    render(
      <AssistantReadiness
        health={{ status: "needs_prepare", models: ["gemma4:26b"], selectedModel: "gemma4:26b" }}
        checking={false}
      />,
    );

    expect(screen.getByTestId("local-assistant-status")).toHaveTextContent("Model needs a one-time copy");
    expect(await screen.findByTestId("local-engine-prepare")).toBeInTheDocument();
    expect(screen.getByTestId("local-engine-step")).toHaveTextContent("gemma4:26b needs a one-time copy");
  });

  it("names a missing model and offers the models that exist instead of a pull command", async () => {
    seedDb({ ollamaModel: "llama3.2:3b" });
    const { container } = render(
      <AssistantReadiness
        health={{ status: "model_missing", models: ["qwen2.5:14b"], selectedModel: "llama3.2:3b" }}
        checking={false}
      />,
    );

    expect(await screen.findByTestId("local-engine-step")).toHaveTextContent("llama3.2:3b wasn't found.");
    expect(screen.getByTestId("local-engine-model-qwen2.5:14b")).toBeInTheDocument();
    expect(screen.queryByTestId("local-engine-start")).toBeNull();
    expectNoCommand(container);
  });

  it("never turns a model name with shell characters into a command", async () => {
    seedDb({ ollamaModel: "x & calc.exe" });
    const { container } = render(
      <AssistantReadiness
        health={{ status: "model_missing", models: ["qwen2.5:14b"], selectedModel: "x & calc.exe" }}
        checking={false}
      />,
    );

    // The name is only ever shown as text, never offered to run or to paste.
    expect(await screen.findByTestId("local-engine-step")).toHaveTextContent("x & calc.exe wasn't found.");
    expect(screen.queryByTestId("local-engine-start")).toBeNull();
    expect(screen.queryByTestId("local-engine-prepare")).toBeNull();
    expect(engine.start).not.toHaveBeenCalled();
    expect(engine.prepare).not.toHaveBeenCalled();
    expectNoCommand(container);
  });

  it("refuses a cloud-backed model and is never ready with one", () => {
    seedDb({ ollamaModel: "glm-4.7:cloud" });
    render(
      <AssistantReadiness
        compact
        health={{
          status: "error",
          models: ["qwen2.5:14b"],
          detail: "model_cloud_backed",
          selectedModel: "glm-4.7:cloud",
        }}
        checking={false}
      />,
    );

    expect(screen.getByTestId("readiness-error")).toHaveTextContent(/cloud/i);
    expect(screen.getByTestId("local-assistant-status")).toHaveTextContent("Error");
    expect(screen.getByTestId("local-assistant-selected-model")).toHaveTextContent("glm-4.7:cloud");
  });

  it("says what an engine failure means instead of a generic error", () => {
    seedDb();
    render(
      <AssistantReadiness
        compact
        health={{ status: "error", models: [], detail: "model_unreadable", selectedModel: "qwen2.5:14b" }}
        checking={false}
      />,
    );

    expect(screen.getByTestId("readiness-error")).toHaveTextContent("This model file couldn't be read.");
  });

  it("in the conversation, gets out of the way when ready with a tool-capable model", async () => {
    seedDb({ assistantAgentToolsEnabled: true });
    listModels.mockResolvedValue({
      status: "ready",
      models: [{ name: "qwen2.5:14b", capabilities: ["completion", "tools"], tools: true }],
    });
    render(
      <AssistantReadiness
        compact
        health={{
          status: "ready",
          models: ["qwen2.5:14b"],
          endpoint: "http://127.0.0.1:50123",
          selectedModel: "qwen2.5:14b",
        }}
        checking={false}
      />,
    );

    await waitFor(() => expect(listModels).toHaveBeenCalled());
    expect(screen.getByTestId("local-assistant-status")).toHaveTextContent("Ready");
    expect(screen.getByTestId("local-assistant-health-endpoint")).toHaveTextContent("http://127.0.0.1:50123");
    expect(screen.queryByTestId("local-engine-panel")).toBeNull();
    expect(screen.queryByTestId("readiness-no-tools")).toBeNull();
  });

  it("in Settings, keeps the engine strip when ready, to start, stop and pick models", async () => {
    seedDb();
    render(
      <AssistantReadiness
        health={{ status: "ready", models: ["qwen2.5:14b"], selectedModel: "qwen2.5:14b" }}
        checking={false}
      />,
    );

    expect(await screen.findByTestId("local-engine-start")).toBeInTheDocument();
    expect(screen.getByTestId("local-engine-models")).toBeInTheDocument();
  });
});

describe("tool support is the selected model's own answer", () => {
  it("warns when tool proposals are on and the selected model said it has no tools", async () => {
    seedDb({ assistantAgentToolsEnabled: true, ollamaModel: "plain-llm:1b" });
    listModels.mockResolvedValue({
      status: "ready",
      models: [
        { name: "plain-llm:1b", capabilities: ["completion"], tools: false },
        // Another model declaring tools does not stand in for the selected one.
        { name: "qwen2.5:14b", capabilities: ["completion", "tools"], tools: true },
      ],
    });
    render(
      <AssistantReadiness
        compact
        health={{ status: "ready", models: ["plain-llm:1b", "qwen2.5:14b"], selectedModel: "plain-llm:1b" }}
        checking={false}
      />,
    );

    expect(await screen.findByTestId("readiness-no-tools")).toHaveTextContent(/can't use tools/);
    expect(screen.getByTestId("readiness-no-tools")).toHaveTextContent(/still answers/);
  });

  it("renders tools: null as unknown, never as no", async () => {
    seedDb({ assistantAgentToolsEnabled: true, ollamaModel: "mystery:8b" });
    listModels.mockResolvedValue({
      status: "ready",
      models: [{ name: "mystery:8b", capabilities: ["completion"], tools: null }],
    });
    render(
      <AssistantReadiness
        compact
        health={{ status: "ready", models: ["mystery:8b"], selectedModel: "mystery:8b" }}
        checking={false}
      />,
    );

    await waitFor(() => expect(listModels).toHaveBeenCalled());
    expect(screen.queryByTestId("readiness-no-tools")).toBeNull();
  });

  it("does not ask for tool support while tool proposals are off", () => {
    seedDb({ assistantAgentToolsEnabled: false });
    render(
      <AssistantReadiness
        compact
        health={{ status: "ready", models: ["qwen2.5:14b"], selectedModel: "qwen2.5:14b" }}
        checking={false}
      />,
    );

    expect(listModels).not.toHaveBeenCalled();
    expect(screen.queryByTestId("readiness-no-tools")).toBeNull();
  });
});
