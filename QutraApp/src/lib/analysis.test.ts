import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import { analysis } from "./analysis";

/* Built-in analysis: the page asks Rust for analyzers, runs, a new run and a run's
   raw output; it never names a path. */

afterEach(() => {
  invoke.mockReset();
  resetBridgeForTesting();
});

describe("built-in analysis calls", () => {
  it("names each command with its arguments", async () => {
    invoke.mockResolvedValue([]);
    await analysis.analyzers();
    await analysis.list("eng_1");
    await analysis.run("eng_1", "file_1", "entropy");
    await analysis.output("ana-1");

    expect(invoke.mock.calls).toEqual([
      ["analysis_analyzers"],
      ["analysis_list", { engagementId: "eng_1" }],
      ["analysis_run", { engagementId: "eng_1", fileId: "file_1", analyzer: "entropy" }],
      ["analysis_output", { runId: "ana-1" }],
    ]);
  });

  it("is there only in the desktop app", () => {
    setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
    expect(analysis.available()).toBe(true);
    setBridgeForTesting({ mode: "browser" } as unknown as DesktopBridge);
    expect(analysis.available()).toBe(false);
  });
});
