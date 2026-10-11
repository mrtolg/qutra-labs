import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import type { NativeToolRun } from "@/lib/bridge/types";
import { createEngagement } from "@/services/appService";
import { RunsOutputSegment } from "@/app/context/RunsOutputSegment";
import OverviewPage from "@/features/overview/OverviewPage";
import { NMAP, installation, resetRuntime, run } from "@/test/labFixtures";
import { useLabRuntime } from "@/state/labRuntime";
import LabPage from "./LabPage";
import { ToolLabPanel } from "./ToolLabPanel";

/* A run made from a descriptor (ExifTool, YARA, capinfos) is shown
   in its file's Önerilen analiz. Its argument list, command line, folders and
   output tails hold the path of the verified copy, so none of the old run
   lists may receive it: the Runs table, Overview's recent runs, the header's
   active count and the Output panel with its save-as-evidence action. The
   lists read the store, and the store never holds such a run. */

const COPY = "C:\\Users\\samil\\AppData\\Roaming\\app.contextos.desktop\\engagements\\e1\\files\\photo.jpg.sample";
const LOGS = "C:\\Users\\samil\\AppData\\Roaming\\app.contextos.desktop\\runs\\run-1";

let engagementId = "";

/** What Rust lists for an outside program's run: the copy's path everywhere. */
function described(overrides: Partial<NativeToolRun>): NativeToolRun {
  return run({
    engagementId,
    kind: "external",
    descriptorId: "exiftool",
    subject: { fileId: "file_1", fileSha256: "ab".repeat(32) },
    argv: ["-json", COPY],
    commandPreview: `exiftool.exe -json ${COPY}`,
    workingDir: LOGS,
    artifactDir: LOGS,
    stdoutTail: `[{"SourceFile": "${COPY}"}]`,
    stderrTail: `Warning: ${COPY}`,
    bytesOut: 40,
    startedAt: 1_759_300_000_000,
    endedAt: 1_759_300_000_900,
    artifacts: [{ kind: "stdout", path: `${LOGS}\\stdout.log`, sizeBytes: 40, truncated: false }],
    updatedAt: 1_759_300_009_999,
    ...overrides,
  });
}

const LEGACY = () =>
  run({
    engagementId,
    state: "succeeded",
    commandPreview: "nmap -sV 10.0.0.5",
    stdoutTail: "Nmap done",
    startedAt: 1_759_300_000_000,
    endedAt: 1_759_300_001_000,
    updatedAt: 1_759_300_001_000,
  });

const supervisor = {
  cancel: vi.fn().mockResolvedValue(undefined),
  emergencyStop: vi.fn().mockResolvedValue(undefined),
};

/** The store as Rust fills it: through `refresh`, from the supervisor's list. */
async function readFromRust(listed: NativeToolRun[]) {
  setBridgeForTesting({
    mode: "tauri",
    toolSupervisor: {
      available: () => true,
      listInstallations: async () => [installation(NMAP, "Nmap")],
      listRuns: async () => listed,
      onEvent: vi.fn().mockResolvedValue(() => {}),
      ...supervisor,
    },
  } as unknown as DesktopBridge);
  getDb().prefs.set({ privateToolsEnabled: true });
  await useLabRuntime.getState().refresh();
  // Subscribed, so opening a page does not read a second time.
  useLabRuntime.setState({ subscribed: true });
}

async function renderLab(view: string) {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[`/lab?e=${engagementId}&view=${view}`]}>
        <Routes>
          <Route path="*" element={<LabPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

const noCopyPath = () => {
  const text = document.body.textContent ?? "";
  expect(text).not.toContain("photo.jpg.sample");
  expect(text).not.toContain("exiftool.exe");
  expect(text).not.toContain("SourceFile");
  expect(text).not.toContain("AppData");
};

beforeEach(() => {
  supervisor.cancel.mockClear();
  supervisor.emergencyStop.mockClear();
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  engagementId = createEngagement("Home lab");
});

afterEach(() => {
  resetRuntime();
  resetBridgeForTesting();
  setDbForTesting(null);
});

describe("a described run is kept out of the old run lists", () => {
  const listed = () => [
    // Newest first, as Rust lists them: the described ones would be selected.
    described({ state: "running", endedAt: undefined, id: "run-described-live" }),
    described({ state: "failed", terminationReason: "non_zero_exit", id: "run-described-failed" }),
    described({ state: "succeeded", id: "run-described-done" }),
    LEGACY(),
  ];

  it("never puts one in the store, selects one, or mirrors one", async () => {
    useLabRuntime.setState({
      logs: {
        "run-described-live": [{ at: 1, stream: "stdout", text: `{"SourceFile": "${COPY}"}` }],
      },
      clearedLogs: { "run-described-live": true },
    });
    const all = listed();

    await readFromRust(all);

    const state = useLabRuntime.getState();
    expect(state.runs.map((r) => r.id)).toEqual([all[3]!.id]);
    expect(state.selectedRunId).toBe(all[3]!.id);
    expect(state.logs).toEqual({});
    expect(state.clearedLogs).toEqual({});
    // Only that one is live, and the store keeps no more of it than its ids.
    expect(state.outsideLive).toEqual([{ id: "run-described-live", engagementId }]);
    expect(getDb().collection("toolRuns").getAll().map((r) => r.id)).toEqual([all[3]!.id]);
    expect(JSON.stringify(getDb().collection("toolRuns").getAll())).not.toContain("photo.jpg.sample");
    expect(JSON.stringify(getDb().collection("artifacts").getAll())).not.toContain("AppData");
  });

  it("keeps a run the user started from the list as before", async () => {
    const mine = LEGACY();
    useLabRuntime.setState({ selectedRunId: mine.id, logs: { [mine.id]: [{ at: 1, stream: "stdout", text: "kept" }] } });

    await readFromRust([described({ id: "run-described-done" }), mine]);

    expect(useLabRuntime.getState().selectedRunId).toBe(mine.id);
    expect(useLabRuntime.getState().logs[mine.id]).toHaveLength(1);
  });

  it("shows none in the Runs table", async () => {
    await readFromRust(listed());
    await renderLab("runs");

    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2); // header and the one scan
    expect(within(table).getByText("Succeeded")).toBeInTheDocument();
    noCopyPath();
  });

  it("shows none in Overview's recent runs, and counts the live one, by its id alone, in the header", async () => {
    await readFromRust(listed());
    await renderLab("overview");

    expect(await screen.findByText("nmap -sV 10.0.0.5")).toBeInTheDocument();
    // Running in Rust: the header says so, without any of its strings.
    expect(screen.getByTestId("lab-active-runs")).toHaveTextContent("1 active runs");
    noCopyPath();
  });

  it("shows none in the Output panel, which can save a run's tails as evidence", async () => {
    const all = listed();
    await readFromRust(all);
    await act(async () => {
      render(
        <MemoryRouter>
          <RunsOutputSegment />
        </MemoryRouter>,
      );
    });

    // The panel opens on the one scan, whose output can be saved.
    expect(await screen.findByText("Nmap done")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save output as evidence" })).toBeInTheDocument();
    noCopyPath();
    expect(getDb().collection("evidence").getAll()).toEqual([]);
  });
});

/* The lists do not get the run, but "something is running, stop it" needs only
   that it is: the store keeps the id and the investigation of a live one, and
   nothing else of it. */
describe("a live described run stays counted and stoppable", () => {
  const live = () => described({ state: "running", endedAt: undefined, id: "run-described-live" });
  const finished = () => described({ state: "succeeded", id: "run-described-done" });
  const stopAll = () => screen.getByRole("button", { name: "Stop all runs" });

  async function renderTools() {
    await act(async () => {
      render(
        <MemoryRouter>
          <ToolLabPanel targets={[]} />
        </MemoryRouter>,
      );
    });
  }
  async function renderHome() {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={["/overview"]}>
          <Routes>
            <Route path="*" element={<OverviewPage />} />
          </Routes>
        </MemoryRouter>,
      );
    });
  }

  it("keeps the id and investigation of each live one, only, and drops them with Private Lab", async () => {
    const other = described({
      state: "starting",
      id: "run-described-other",
      engagementId: "eng_other",
      endedAt: undefined,
    });
    await readFromRust([live(), finished(), other, LEGACY()]);

    const kept = useLabRuntime.getState().outsideLive;
    expect(kept).toEqual([
      { id: "run-described-live", engagementId },
      { id: "run-described-other", engagementId: "eng_other" },
    ]);
    expect(JSON.stringify(kept)).not.toMatch(/photo|exiftool|AppData|SourceFile/);

    useLabRuntime.getState().revoke();
    expect(useLabRuntime.getState().outsideLive).toEqual([]);
  });

  it("shows Stop all runs in Tools when only a described run is live, and stops everything with it", async () => {
    await readFromRust([live()]);
    await renderTools();

    fireEvent.click(stopAll());

    await waitFor(() => expect(supervisor.emergencyStop).toHaveBeenCalledTimes(1));
    noCopyPath();
  });

  it("shows no Stop all runs in Tools when the described runs have ended", async () => {
    await readFromRust([finished()]);
    await renderTools();

    // The tool list is up, so a missing button is not a page that did not load.
    expect((await screen.findAllByText("Nmap")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Stop all runs" })).toBeNull();
  });

  it("stops it from the header, counting only this investigation's", async () => {
    const other = described({
      state: "running",
      id: "run-described-other",
      engagementId: "eng_other",
      endedAt: undefined,
    });
    await readFromRust([live(), other]);
    await renderLab("overview");

    expect(screen.getByTestId("lab-active-runs")).toHaveTextContent("1 active runs");
    fireEvent.click(stopAll());

    await waitFor(() => expect(supervisor.cancel).toHaveBeenCalledTimes(1));
    expect(supervisor.cancel).toHaveBeenCalledWith("run-described-live");
  });

  it("does not tell Home that nothing is running while one is", async () => {
    await readFromRust([live()]);
    await renderHome();

    expect(screen.queryByText(/Nothing is running/)).toBeNull();
    noCopyPath();
  });

  it("tells Home that nothing is running once the described runs have ended", async () => {
    await readFromRust([finished()]);
    await renderHome();

    expect(screen.getByText(/^Nothing is running/)).toBeInTheDocument();
  });
});
