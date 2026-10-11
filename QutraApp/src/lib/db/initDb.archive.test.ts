import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETIRED_ARCHIVE_KEY } from "./migrations";

/* Boot on the desktop: data retired by an earlier version is archived once by
   Rust. A refusal there must not stop the app from starting, and the data stays
   to be archived again at the next start. */

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime")>()),
  detectRuntime: () => "tauri",
}));

let archiveAnswer: "ok" | "refused";

function answer(command: string) {
  if (command === "storage_load") {
    return Promise.resolve({
      records: [],
      kv: [{ key: RETIRED_ARCHIVE_KEY, value: '{"format":"contextos-retired-modules"}' }],
    });
  }
  if (command === "archive_retired_data") {
    return archiveAnswer === "ok"
      ? Promise.resolve("path")
      : Promise.reject("archive_contains_secret");
  }
  return Promise.resolve(undefined);
}

/** Keys the app asked to remove from storage. */
function removedKeys(): string[] {
  return invoke.mock.calls
    .filter(([command]) => command === "storage_apply_writes")
    .flatMap(([, args]) => (args as { writes: { kind: string; key?: string }[] }).writes)
    .filter((write) => write.kind === "remove" && write.key)
    .map((write) => write.key as string);
}

beforeEach(() => {
  vi.resetModules();
  invoke.mockImplementation(answer);
});

afterEach(() => {
  invoke.mockReset();
  vi.restoreAllMocks();
});

describe("initDb with data retired by an earlier version", () => {
  it("starts when Rust refuses the archive, and keeps the data for the next start", async () => {
    archiveAnswer = "refused";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { initDb } = await import("./database");

    const db = await initDb();

    expect(db).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("archive_retired_data", expect.anything());
    expect(removedKeys()).not.toContain(RETIRED_ARCHIVE_KEY);
  });

  it("drops the retired data once it is archived", async () => {
    archiveAnswer = "ok";
    const { initDb } = await import("./database");

    await initDb();

    await vi.waitFor(() => expect(removedKeys()).toContain(RETIRED_ARCHIVE_KEY));
  });
});
