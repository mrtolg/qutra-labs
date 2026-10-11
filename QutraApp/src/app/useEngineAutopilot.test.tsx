import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetAutoEngineForTesting, useAutoEngine } from "@/lib/localEngine/autoEngine";
import { useUi } from "@/state/ui";

const ensure = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/localEngine/autoEngine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/localEngine/autoEngine")>()),
  ensureLocalEngine: ensure,
}));

import { useEngineAutopilot } from "./useEngineAutopilot";

function seed(prefs: Record<string, unknown>) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set(prefs);
  setDbForTesting(db);
}

beforeEach(() => {
  ensure.mockClear();
  resetAutoEngineForTesting();
  useUi.setState({ toasts: [] });
});
afterEach(() => setDbForTesting(null));

describe("the engine looks after itself", () => {
  it("starts what is in place when the app opens with a local route", () => {
    seed({ localAssistantEnabled: true, aiProvider: "ollama", ollamaModel: "gemma4:26b" });
    renderHook(() => useEngineAutopilot());

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith("gemma4:26b", { explicit: false });
  });

  it("does not wake a local model for someone who talks through a cloud service", () => {
    seed({ localAssistantEnabled: true, aiProvider: "anthropic" });
    renderHook(() => useEngineAutopilot());

    expect(ensure).not.toHaveBeenCalled();
  });

  it("does nothing while the assistant is off", () => {
    seed({ localAssistantEnabled: false, aiProvider: "ollama" });
    renderHook(() => useEngineAutopilot());

    expect(ensure).not.toHaveBeenCalled();
  });

  it("makes the engine ready for a model as soon as it is chosen", () => {
    seed({ localAssistantEnabled: true, aiProvider: "anthropic", ollamaModel: "gemma4:26b" });
    renderHook(() => useEngineAutopilot());

    act(() => getDb().prefs.set({ ollamaModel: "qwen2.5:7b" }));

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith("qwen2.5:7b", { explicit: true });
  });

  it("makes it ready when the assistant is switched on", () => {
    seed({ localAssistantEnabled: false, aiProvider: "ollama", ollamaModel: "gemma4:26b" });
    renderHook(() => useEngineAutopilot());

    act(() => getDb().prefs.set({ localAssistantEnabled: true }));

    expect(ensure).toHaveBeenCalledWith("gemma4:26b", { explicit: true });
  });

  it("says once, in a toast, that the engine could not start", () => {
    seed({ localAssistantEnabled: true, aiProvider: "ollama" });
    renderHook(() => useEngineAutopilot());

    act(() => useAutoEngine.setState({ phase: "failed", model: "gemma4:26b", error: { code: "start_failed" } }));

    expect(useUi.getState().toasts.map((toast) => [toast.kind, toast.messageKey])).toEqual([
      ["danger", "engine.auto.failed"],
    ]);
  });
});
