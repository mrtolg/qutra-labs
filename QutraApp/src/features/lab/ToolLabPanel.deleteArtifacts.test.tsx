import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { EvidenceSchema } from "@/domain/findings";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import { NMAP, installation, resetRuntime, run } from "@/test/labFixtures";
import { useLabRuntime } from "@/state/labRuntime";
import { ToolLabPanel } from "./ToolLabPanel";

/* Evidence of an outside tool's run points at that run's saved
   output (`rawRef`). Deleting the output files breaks the link, so the
   question before it says how many pieces of evidence it touches. */

const RUN_ID = "run-00000000-0000-4000-8000-0000000000aa";

function pointingAtRun(id: string, runId = RUN_ID) {
  return EvidenceSchema.parse({
    id,
    engagementId: "eng_1",
    runId,
    fileId: "file_1",
    kind: "observation",
    observationIds: [`${runId}:0`],
    title: `Camera ${id}`,
    source: "tool:exiftool",
    rawRef: { relPath: `runs/${runId}/stdout.log`, sha256: "00" },
    capturedAt: 1,
    createdAt: 1,
  });
}

function open(evidence: ReturnType<typeof pointingAtRun>[] = []) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ privateToolsEnabled: true });
  for (const item of evidence) db.collection("evidence").put(item);
  setDbForTesting(db);
  const deleteArtifacts = vi.fn().mockResolvedValue(undefined);
  setBridgeForTesting({
    mode: "tauri",
    toolSupervisor: {
      available: () => true,
      listInstallations: async () => [installation(NMAP, "Nmap")],
      listRuns: async () => [],
      onEvent: vi.fn().mockResolvedValue(() => {}),
      deleteArtifacts,
    },
  } as unknown as DesktopBridge);
  useLabRuntime.setState({
    available: true,
    ready: true,
    subscribed: true,
    installations: [installation(NMAP, "Nmap")],
    runs: [
      run({
        id: RUN_ID,
        state: "succeeded",
        commandPreview: "nmap -sV 10.0.0.5",
        artifacts: [{ kind: "stdout", path: "C:\\runs\\x\\stdout.log", sizeBytes: 12, truncated: false }],
      }),
    ],
    logs: {},
    clearedLogs: {},
    selectedRunId: RUN_ID,
    error: "",
  });
  render(
    <MemoryRouter>
      <ToolLabPanel targets={[]} />
    </MemoryRouter>,
  );
  return deleteArtifacts;
}

afterEach(() => {
  resetRuntime();
  resetBridgeForTesting();
  setDbForTesting(null);
  vi.restoreAllMocks();
});

describe("Delete output files", () => {
  it("keeps the plain question when no evidence points at the run", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const deleteArtifacts = open([pointingAtRun("ev_other", "run-00000000-0000-4000-8000-0000000000bb")]);

    await userEvent.click(await screen.findByRole("button", { name: "Delete output files" }));

    expect(confirm).toHaveBeenCalledWith(
      "Delete the saved output files for this run? The run history and the last lines of output are kept.",
    );
    expect(deleteArtifacts).not.toHaveBeenCalled();
  });

  it("says how many pieces of evidence point at the output, and deletes only on a yes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const deleteArtifacts = open([pointingAtRun("ev_1"), pointingAtRun("ev_2")]);
    expect(getDb().collection("evidence").getAll()).toHaveLength(2);

    await userEvent.click(await screen.findByRole("button", { name: "Delete output files" }));
    expect(confirm).toHaveBeenLastCalledWith(
      "2 piece(s) of evidence point at the saved output of this scan. The evidence keeps its own copy, but you will no longer be able to open or check the output. Delete it anyway?",
    );
    expect(deleteArtifacts).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete output files" }));
    await waitFor(() => expect(deleteArtifacts).toHaveBeenCalledWith(RUN_ID));
  });
});
