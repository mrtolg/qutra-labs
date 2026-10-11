import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const ensure = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/localEngine/autoEngine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/localEngine/autoEngine")>()),
  ensureLocalEngine: ensure,
}));
vi.mock("@/lib/ai/localModels", () => ({
  listLocalModels: async () => [
    { id: "gemma4:26b", name: "gemma4:26b", source: "ollama" },
    { id: "qwen2.5:7b", name: "qwen2.5:7b", source: "ollama" },
  ],
}));

import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { ModelChip } from "./ModelChip";

beforeEach(() => {
  ensure.mockClear();
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ localAssistantEnabled: true, aiProvider: "ollama", ollamaModel: "gemma4:26b" });
  setDbForTesting(db);
});
afterEach(() => setDbForTesting(null));

const chip = () => (
  <ModelChip conversationId={null} resolved={{ provider: "local", model: "gemma4:26b", own: false }} />
);

describe("choosing a model in the composer", () => {
  it("gets the engine ready for a local model chosen for one conversation", async () => {
    render(chip());

    await userEvent.click(screen.getByTestId("jarvis-model-chip"));
    await userEvent.click(await screen.findByRole("radio", { name: "qwen2.5:7b" }));

    expect(ensure).toHaveBeenCalledWith("qwen2.5:7b", { explicit: true });
  });

  it("does not wake the local engine when the default is restored", async () => {
    render(chip());

    await userEvent.click(screen.getByTestId("jarvis-model-chip"));
    await screen.findByRole("radio", { name: "qwen2.5:7b" });

    expect(ensure).not.toHaveBeenCalled();
  });
});
