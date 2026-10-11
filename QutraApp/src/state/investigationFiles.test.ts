import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useInvestigationFiles } from "./investigationFiles";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import type { AddOutcome, InvestigationFile } from "@/lib/investigationFiles";

function file(id: string, addedAt: number): InvestigationFile {
  return {
    id,
    engagementId: "eng_1",
    relPath: `files/${id}.txt`,
    name: `${id}.txt`,
    originalName: `${id}.txt`,
    bytes: 3,
    sha256: "a".repeat(64),
    sha1: "b".repeat(40),
    md5: "c".repeat(32),
    kind: "text",
    sample: false,
    source: "picked",
    addedAt,
    missing: false,
    readOnly: true,
  };
}

const ids = (engagementId: string) =>
  (useInvestigationFiles.getState().byEngagement[engagementId] ?? []).map((f) => f.id);

beforeEach(() => {
  invoke.mockReset();
  useInvestigationFiles.setState({
    byEngagement: {},
    loadState: {},
    dropTarget: null,
    dragOver: false,
  });
  setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
});

afterEach(() => {
  resetBridgeForTesting();
});

describe("investigation files", () => {
  it("loads an investigation's files from Rust, newest first", async () => {
    invoke.mockResolvedValueOnce([file("old", 1), file("new", 2)]);

    await useInvestigationFiles.getState().load("eng_1");

    expect(invoke).toHaveBeenCalledWith("investigation_files_list", { engagementId: "eng_1" });
    expect(ids("eng_1")).toEqual(["new", "old"]);
    expect(useInvestigationFiles.getState().loadState.eng_1).toBe("ready");
  });

  it("says when the list could not be read", async () => {
    invoke.mockRejectedValueOnce("files_lock_failed");

    await useInvestigationFiles.getState().load("eng_1");

    expect(useInvestigationFiles.getState().loadState.eng_1).toBe("failed");
    expect(ids("eng_1")).toEqual([]);
  });

  it("adds what a pick copied once and hands every outcome back", async () => {
    useInvestigationFiles.setState({ byEngagement: { eng_1: [file("a", 1)] } });
    const outcomes: AddOutcome[] = [
      { outcome: "added", file: file("b", 2) },
      { outcome: "duplicate", file: file("a", 1) },
      { outcome: "failed", originalName: "disk.iso", reason: "too_large" },
    ];
    invoke.mockResolvedValueOnce(outcomes);

    const result = await useInvestigationFiles.getState().pick("eng_1", "Add files");

    expect(invoke).toHaveBeenCalledWith("investigation_files_pick", {
      engagementId: "eng_1",
      title: "Add files",
    });
    expect(result).toEqual(outcomes);
    expect(ids("eng_1")).toEqual(["b", "a"]);
  });

  it("keeps a picked file when an older list arrives after it", async () => {
    let resolveList!: (files: InvestigationFile[]) => void;
    invoke.mockImplementation((command: string) =>
      command === "investigation_files_list"
        ? new Promise((resolve) => {
            resolveList = resolve;
          })
        : Promise.resolve([{ outcome: "added", file: file("picked", 5) }]),
    );

    const loading = useInvestigationFiles.getState().load("eng_1");
    await useInvestigationFiles.getState().pick("eng_1", "Add files");
    resolveList([file("listed", 1)]);
    await loading;

    expect(ids("eng_1")).toEqual(["picked", "listed"]);
  });

  it("redeems a drop's token for the investigation it was dropped on", async () => {
    invoke.mockResolvedValueOnce([{ outcome: "added", file: file("dropped", 3) }]);

    const result = await useInvestigationFiles.getState().addDropped("tok-1", "eng_1");

    expect(invoke).toHaveBeenCalledWith("investigation_files_add_dropped", {
      token: "tok-1",
      engagementId: "eng_1",
    });
    expect(result).toHaveLength(1);
    expect(ids("eng_1")).toEqual(["dropped"]);
  });

  it("lets a refusal from Rust reach the caller", async () => {
    invoke.mockRejectedValueOnce("no_engagement_folder");

    await expect(useInvestigationFiles.getState().pick("eng_1", "Add files")).rejects.toBe(
      "no_engagement_folder",
    );
  });

  it("never calls Rust in the browser build", async () => {
    setBridgeForTesting({ mode: "browser" } as unknown as DesktopBridge);

    await useInvestigationFiles.getState().load("eng_1");
    expect(await useInvestigationFiles.getState().pick("eng_1", "Add files")).toEqual([]);
    expect(await useInvestigationFiles.getState().addDropped("tok-1", "eng_1")).toEqual([]);

    expect(invoke).not.toHaveBeenCalled();
  });
});
