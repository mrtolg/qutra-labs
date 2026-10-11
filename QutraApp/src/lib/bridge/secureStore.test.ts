import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { BrowserBridge } from "./browserBridge";
import { TauriBridge } from "./tauriBridge";

/* Spec 2026-10-07 §6.4, ADR 0005: a stored secret is write-only for
   the page. Rust reads the GitHub token and the AI keys itself; no bridge
   offers a way to read one back. */
describe("secrets are write-only for the page", () => {
  it("neither bridge can read a stored secret back", () => {
    expect("get" in new TauriBridge().secureStore).toBe(false);
    expect("get" in new BrowserBridge().secureStore).toBe(false);
  });

  it("the desktop store still saves, tests for and deletes by name", async () => {
    invoke.mockResolvedValue(true);
    const store = new TauriBridge().secureStore;

    await store.set("github.token", "ghp_secret_value_1234567890");
    expect(await store.has("github.token")).toBe(true);
    await store.delete("github.token");

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "secure_set",
      "secure_has",
      "secure_delete",
    ]);
  });
});
