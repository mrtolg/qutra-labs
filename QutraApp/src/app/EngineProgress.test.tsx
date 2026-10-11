import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetAutoEngineForTesting, useAutoEngine } from "@/lib/localEngine/autoEngine";
import { ENGINE_TASK_EVENT, type LocalEngineClient, type TaskEvent } from "@/lib/localEngine/client";
import { EngineProgress } from "./EngineProgress";

function fakeClient() {
  let handler: ((task: TaskEvent) => void) | null = null;
  const client = {
    available: () => true,
    listen: vi.fn(async (event: string, h: (task: TaskEvent) => void) => {
      if (event === ENGINE_TASK_EVENT) handler = h;
      return () => {
        handler = null;
      };
    }),
  } as unknown as LocalEngineClient;
  return { client, emit: (task: TaskEvent) => act(() => handler?.(task)) };
}

const task = (over: Partial<TaskEvent>): TaskEvent => ({
  kind: "install",
  phase: "running",
  model: null,
  doneBytes: 0,
  totalBytes: 100,
  error: null,
  ...over,
});

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  resetAutoEngineForTesting();
});
afterEach(() => setDbForTesting(null));

describe("the engine's progress card", () => {
  it("is absent while nothing is being made ready", async () => {
    const { client } = fakeClient();
    await act(async () => void render(<EngineProgress client={client} />));

    expect(screen.queryByTestId("engine-progress")).not.toBeInTheDocument();
  });

  it("follows the download, the copy of the chosen model and its loading", async () => {
    const { client, emit } = fakeClient();
    await act(async () => void render(<EngineProgress client={client} />));

    await act(async () => useAutoEngine.setState({ phase: "installing", model: "qwen2.5:7b", error: null }));
    expect(screen.getByTestId("engine-progress")).toHaveTextContent("Getting the local assistant ready…");
    await emit(task({ doneBytes: 50 }));
    expect(screen.getByTestId("engine-progress")).toHaveTextContent("Downloading the engine… 50 B of 100 B");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");

    await act(async () => useAutoEngine.setState({ phase: "preparing", model: "qwen2.5:7b", error: null }));
    await emit(task({ kind: "prepare", model: "qwen2.5:7b", doneBytes: 25 }));
    expect(screen.getByTestId("engine-progress")).toHaveTextContent("Preparing qwen2.5:7b… 25%");

    await act(async () => useAutoEngine.setState({ phase: "starting", model: "qwen2.5:7b", error: null }));
    expect(screen.getByTestId("engine-progress")).toHaveTextContent("Loading qwen2.5:7b into memory…");

    await act(async () => useAutoEngine.setState({ phase: "ready", model: "qwen2.5:7b", error: null }));
    expect(screen.queryByTestId("engine-progress")).not.toBeInTheDocument();
  });
});
