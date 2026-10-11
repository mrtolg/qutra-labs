import { afterEach, describe, expect, it, vi } from "vitest";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { LocalEngineCommandError, localEngine } from "@/lib/localEngine/client";
import { listLocalModels, LocalModelsUnavailable } from "./localModels";

vi.mock("@/lib/localEngine/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/localEngine/client")>();
  return { ...actual, localEngine: { models: vi.fn(), available: vi.fn(() => true) } };
});

const models = vi.mocked(localEngine.models);
const available = vi.mocked(localEngine.available);

function seedDb(localAssistantEnabled: boolean) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ localAssistantEnabled });
  setDbForTesting(db);
}

afterEach(() => {
  setDbForTesting(null);
  vi.clearAllMocks();
  available.mockReturnValue(true);
});

const base = { architecture: "gemma4", tools: true, prepared: false };

describe("listLocalModels", () => {
  it("asks nothing while the local engine is off", async () => {
    seedDb(false);
    await expect(listLocalModels()).resolves.toEqual([]);
    expect(models).not.toHaveBeenCalled();
  });

  it("lists the models the engine runs, or will after their one-time copy", async () => {
    seedDb(true);
    models.mockResolvedValue({
      ollamaStore: true,
      freeBytes: 1,
      models: [
        { ...base, id: "gemma4:26b", name: "gemma4:26b", source: "ollama", sizeBytes: 18, state: "needs_prepare", writeBytes: 17 },
        { ...base, id: "qwen2.5:7b", name: "qwen2.5:7b", source: "ollama", sizeBytes: 4, state: "ready" },
        { ...base, id: "Mine", name: "Mine", source: "folder", sizeBytes: 2, state: "ready" },
        { ...base, id: "odd", name: "odd", source: "folder", sizeBytes: 1, state: "unsupported", unsupportedArchitecture: "odd" },
      ],
    });
    await expect(listLocalModels()).resolves.toEqual([
      { id: "gemma4:26b", name: "gemma4:26b", sizeBytes: 18, source: "ollama" },
      { id: "qwen2.5:7b", name: "qwen2.5:7b", sizeBytes: 4, source: "ollama" },
      { id: "Mine", name: "Mine", sizeBytes: 2, source: "folder" },
    ]);
  });

  it("rejects when the engine cannot be asked", async () => {
    seedDb(true);
    models.mockRejectedValue(new LocalEngineCommandError({ code: "io" }));
    const err = await listLocalModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalModelsUnavailable);
    expect((err as LocalModelsUnavailable).reason).toBe("io");
  });

  it("rejects in the browser build without asking", async () => {
    seedDb(true);
    available.mockReturnValue(false);
    await expect(listLocalModels()).rejects.toBeInstanceOf(LocalModelsUnavailable);
    expect(models).not.toHaveBeenCalled();
  });
});
