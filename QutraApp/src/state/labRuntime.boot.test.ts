import { afterEach, describe, expect, it, vi } from "vitest";

const tauriWindow = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete tauriWindow.__TAURI_INTERNALS__;
  vi.resetModules();
});

describe("lab runtime desktop boot", () => {
  it("can initialize before the native bridge module is preloaded", async () => {
    tauriWindow.__TAURI_INTERNALS__ = {};
    vi.resetModules();

    const { useLabRuntime } = await import("./labRuntime");

    expect(useLabRuntime.getState().available).toBe(true);
    expect(useLabRuntime.getState().ready).toBe(false);
  });
});
