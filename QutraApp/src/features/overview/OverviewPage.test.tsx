import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Database, setDbForTesting, getDb } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { getBridge, resetBridgeForTesting } from "@/lib/bridge";
import type { NativeToolInstallation, NativeToolRun } from "@/lib/bridge/types";
import { useLabRuntime } from "@/state/labRuntime";
import { createEngagement } from "@/services/appService";
import { FindingSchema } from "@/domain/findings";
import { useUi } from "@/state/ui";
import OverviewPage from "./OverviewPage";

/* Home opens with what to investigate (spec 2026-10-07 §5.2), then a dashboard
   built from real records only: sections render when their data exists.
   Pending approvals and live terminal sessions join once Home has
   a native source for them. */

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/overview"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <OverviewPage />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const NOW = Date.now();

function freshDb() {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
}

function installation(id: string, displayName: string): NativeToolInstallation {
  return {
    id,
    displayName,
    runner: "executable",
    canonicalPath: `C:\\Program Files\\${displayName}\\${displayName}.exe`,
    sha256: "b".repeat(64),
    sizeBytes: 1,
    version: "1",
    publisher: "",
    signatureState: "valid",
    category: "network",
    riskTier: "medium",
    docUrl: "",
    tags: [],
    workingDir: "",
    enabled: true,
    changedSinceVerify: false,
    createdAt: 1,
    updatedAt: 1,
    lastVerifiedAt: 1,
  };
}

// Ids shaped like production (UUIDs), not hand-written names.
const NMAP = "7f3c2a9e-51d4-4c1b-9a0e-2d6b8f4e1c37";
const GITLEAKS = "c0a8e4b2-9d17-4f6e-8b53-1e2f7a9c6d40";

function run(overrides: Partial<NativeToolRun>): NativeToolRun {
  return {
    id: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    profileId: crypto.randomUUID(),
    installationId: NMAP,
    state: "succeeded",
    argv: [],
    commandPreview: "",
    terminationReason: "",
    workingDir: "",
    artifactDir: "",
    stdoutTail: "",
    stderrTail: "",
    bytesOut: 0,
    truncated: false,
    blockedReason: "",
    kind: "external",
    trigger: { by: "user" },
    outputs: [],
    observations: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as NativeToolRun;
}

function seedRuntime(runs: NativeToolRun[], readFailed = false) {
  getDb().prefs.set({ privateToolsEnabled: true });
  useLabRuntime.setState({
    available: true,
    ready: true,
    readFailed,
    subscribed: true,
    installations: [installation(NMAP, "Nmap"), installation(GITLEAKS, "Gitleaks")],
    runs,
    logs: {},
    clearedLogs: {},
    selectedRunId: null,
    error: "",
  });
}

// Tests that swap in a refresh spy put it back, so later cases get the real one.
const realRefresh = useLabRuntime.getState().refresh;

afterEach(() => {
  useLabRuntime.setState({ refresh: realRefresh });
  setDbForTesting(null);
  resetBridgeForTesting();
  useLabRuntime.setState({
    available: false,
    ready: false,
    subscribed: false,
    installations: [],
    runs: [],
    logs: {},
    clearedLogs: {},
    selectedRunId: null,
    error: "",
    readFailed: false,
  });
  useUi.setState({ toasts: [] });
  vi.restoreAllMocks();
});

describe("Home starts an investigation", () => {
  it("offers the five kinds first, with a terminal and Qutra beside them, and no greeting", () => {
    freshDb();
    renderHome();

    const start = screen.getByRole("region", { name: "New investigation" });
    expect(within(start).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual([
      "File",
      "Web application",
      "Host or network",
      "PCAP",
      "Forensics",
      "New terminal",
      "Ask Qutra",
    ]);
    expect(screen.queryByText(/that's the whole home screen/)).toBeNull();
    expect(screen.queryByText(/^Good (morning|afternoon|evening)$/)).toBeNull();
  });

  it("a kind asks for the name in Investigations before making anything", () => {
    freshDb();
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "PCAP" }));

    expect(getDb().collection("engagements").getAll()).toEqual([]);
    expect(screen.getByTestId("where").textContent).toBe("/lab?new=1&kind=pcap");
  });

  it("Ask Qutra opens the assistant", () => {
    freshDb();
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "Ask Qutra" }));
    expect(screen.getByTestId("where").textContent).toBe("/jarvis");
  });
});

describe("Home recent investigations", () => {
  it("lists the five latest, newest first, each opening itself", () => {
    freshDb();
    const db = getDb();
    for (let n = 1; n <= 6; n++) {
      const id = createEngagement(`Investigation ${n}`);
      db.collection("engagements").put({ ...db.collection("engagements").get(id)!, updatedAt: NOW - (10 - n) * 60_000 });
    }
    renderHome();

    const panel = screen.getByRole("region", { name: "Recent investigations" });
    const rows = within(panel).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("Investigation 6");
    expect(within(rows[0]!).getByRole("link")).toHaveAttribute(
      "href",
      expect.stringContaining("/lab?e="),
    );
    // "All" opens the list of every investigation, not the newest one.
    expect(within(panel).getByRole("link", { name: "All investigations" })).toHaveAttribute(
      "href",
      "/lab?list=1",
    );
  });

  it("names the kind, General when none was chosen, and leaves out archived ones", () => {
    freshDb();
    const db = getDb();
    createEngagement("Office capture", "pcap");
    createEngagement("Old notes");
    const archived = createEngagement("Archived one");
    db.collection("engagements").put({ ...db.collection("engagements").get(archived)!, status: "archived" });
    renderHome();

    const panel = screen.getByRole("region", { name: "Recent investigations" });
    expect(within(panel).getByText("Office capture").closest("a")).toHaveTextContent("PCAP ·");
    expect(within(panel).getByText("Old notes").closest("a")).toHaveTextContent("General ·");
    expect(within(panel).queryByText("Archived one")).toBeNull();
  });
});

describe("Home brief", () => {
  function important(engagementId: string, severity: "critical" | "high", id: string) {
    getDb()
      .collection("findings")
      .put(
        FindingSchema.parse({
          id,
          engagementId,
          title: `Finding ${id}`,
          severity,
          fingerprint: `fp-${id}`,
          firstSeen: NOW,
          lastSeen: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
  }

  it("invites the first investigation when nothing is saved", () => {
    freshDb();
    renderHome();
    expect(screen.getByRole("heading", { name: "Start your first investigation" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  });

  it("names what needs attention, worst first, each with the action that deals with it", () => {
    freshDb();
    const db = getDb();
    const web = createEngagement("Portal test", "web");
    db.collection("engagements").patch(web, { status: "active" });
    db.collection("authorizationScopes").patch(db.collection("engagements").get(web)!.scopeId!, {
      allowedTargets: ["portal.example.com"],
      testerAck: true,
    });
    important(web, "critical", "f-crit");
    const host = createEngagement("Office hosts", "host");
    db.collection("engagements").patch(host, { status: "active" });
    renderHome();

    expect(screen.getByRole("heading", { name: "2 things need your attention" })).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "Needs attention" });
    const items = within(panel).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Important findings waiting for review (1)");
    expect(within(items[0]!).getByRole("link", { name: "Review findings" })).toHaveAttribute(
      "href",
      `/lab?e=${web}&view=findings`,
    );
    expect(items[1]).toHaveTextContent("Under way without a scope");
    expect(within(items[1]!).getByRole("link", { name: "Set scope" })).toHaveAttribute(
      "href",
      `/lab?e=${host}&view=scope`,
    );
    const glance = screen.getByLabelText("At a glance");
    expect(glance).toHaveTextContent(/open investigations\s*02/);
    expect(glance).toHaveTextContent(/critical\s*01/);
  });

  it("says nothing is waiting once the findings are reviewed", () => {
    freshDb();
    const db = getDb();
    const web = createEngagement("Portal test", "web");
    important(web, "high", "f-high");
    db.collection("findings").patch("f-high", { status: "confirmed" });
    renderHome();

    expect(screen.getByRole("heading", { name: "Nothing is waiting on you" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
    // The open finding still counts, and its severity shows on the row.
    const recent = screen.getByRole("region", { name: "Recent investigations" });
    expect(within(recent).getByText("Open findings: 1 High")).toBeInTheDocument();
  });
});

describe("Home resume", () => {
  it("links to the most recently active project", () => {
    freshDb();
    const put = (id: string, name: string, lastActivityAt: number, status = "active") =>
      getDb()
        .collection("workspaces")
        .put({
          id,
          name,
          color: "#3cc",
          icon: "folder",
          type: "software",
          status,
          createdAt: NOW,
          updatedAt: NOW,
          lastActivityAt,
        } as never);
    put("ws_old", "Older project", NOW - 60_000);
    put("ws_new", "qutra-app", NOW - 1_000);
    put("ws_gone", "Archived one", NOW, "archived");
    renderHome();

    const panel = screen.getByRole("region", { name: "Resume where you left off" });
    const link = within(panel).getByRole("link", { name: /Project · qutra-app/ });
    expect(link).toHaveAttribute("href", "/workspaces/ws_new");
    expect(within(panel).queryByText(/Archived one/)).toBeNull();
  });
});

describe("Home runs", () => {
  it("lists active tool runs, each with its own Stop", () => {
    freshDb();
    const cancel = vi.spyOn(getBridge().toolSupervisor, "cancel").mockResolvedValue();
    const live = run({
      installationId: NMAP,
      state: "running",
      target: "192.168.56.101",
      startedAt: NOW - 72_000,
    });
    seedRuntime([live, run({ installationId: GITLEAKS, state: "succeeded", endedAt: NOW })]);
    renderHome();

    const panel = screen.getByRole("region", { name: "Running" });
    expect(within(panel).getByText("1 live")).toBeInTheDocument();
    expect(within(panel).getByText("192.168.56.101")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Stop the Nmap run" }));
    expect(cancel).toHaveBeenCalledWith(live.id);
    expect(within(panel).queryByText("Gitleaks")).toBeNull();
  });

  it("shows the last five finished runs, newest first, with no link that claims all of them", () => {
    freshDb();
    const finished = Array.from({ length: 7 }, (_, i) =>
      run({
        installationId: i % 2 ? GITLEAKS : NMAP,
        state: i === 1 ? "failed" : "succeeded",
        target: `10.0.0.${i}`,
        startedAt: NOW - (i + 1) * 60_000 - 5_000,
        endedAt: NOW - (i + 1) * 60_000,
      }),
    );
    seedRuntime([...finished].reverse());
    renderHome();

    const panel = screen.getByRole("region", { name: "Recent runs" });
    const rows = within(panel).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => within(r).getAllByRole("cell")[1]!.textContent)).toEqual([
      "10.0.0.0",
      "10.0.0.1",
      "10.0.0.2",
      "10.0.0.3",
      "10.0.0.4",
    ]);
    expect(within(rows[1]!).getByText("Failed")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("00:00:05")).toBeInTheDocument();
    // An investigation's Runs list only its own runs, so nothing here says "all".
    expect(within(panel).queryByRole("link")).toBeNull();
  });

  it("says so when Stop is refused, and re-reads the runs", async () => {
    freshDb();
    vi.spyOn(getBridge().toolSupervisor, "cancel").mockRejectedValue("run_not_active");
    const refresh = vi.fn().mockResolvedValue(undefined);
    seedRuntime([run({ installationId: NMAP, state: "running", startedAt: NOW })]);
    useLabRuntime.setState({ refresh });
    renderHome();

    fireEvent.click(screen.getByRole("button", { name: "Stop the Nmap run" }));
    await waitFor(() =>
      expect(useUi.getState().toasts.map((t) => t.messageKey)).toEqual(["home.stopFailed"]),
    );
    expect(useUi.getState().toasts[0]!.params).toEqual({ tool: "Nmap" });
    expect(refresh).toHaveBeenCalled();
  });

  it("does not claim nothing is running when the runs could not be read", () => {
    freshDb();
    const refresh = vi.fn().mockResolvedValue(undefined);
    seedRuntime([], true);
    useLabRuntime.setState({ refresh });
    renderHome();

    expect(screen.queryByText(/Nothing is running/)).toBeNull();
    const notice = screen.getByRole("region", { name: "Running" });
    expect(within(notice).getByText(/could not be read/)).toBeInTheDocument();
    fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalled();
    // The ways to start stay available.
    expect(screen.getByRole("button", { name: "File" })).toBeEnabled();
  });

  it("does not claim nothing is running while the first read is under way", () => {
    freshDb();
    seedRuntime([]);
    useLabRuntime.setState({ ready: false });
    renderHome();
    expect(screen.queryByText(/Nothing is running/)).toBeNull();
    expect(screen.getByRole("region", { name: "New investigation" })).toBeInTheDocument();
  });

  it("does not claim nothing is running when Private Lab consent is withdrawn", () => {
    // Withdrawing consent only gates listing; a run started before
    // can still be alive natively, so an empty store proves nothing.
    freshDb();
    seedRuntime([]);
    getDb().prefs.set({ privateToolsEnabled: false });
    renderHome();
    expect(screen.queryByText(/Nothing is running/)).toBeNull();
    expect(screen.getByText("What do you want to look into?")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "New investigation" })).getAllByRole("button")).toHaveLength(7);
  });

  it("says nothing is running after a good native read that found none", () => {
    freshDb();
    seedRuntime([]);
    renderHome();
    expect(screen.getByText(/^Nothing is running/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "New investigation" })).getAllByRole("button")).toHaveLength(7);
  });

  it("keeps the create-actions above past runs when nothing is in progress", () => {
    // The installed app with only finished runs showed a lone history table
    // and nothing to start from.
    freshDb();
    seedRuntime([run({ installationId: NMAP, state: "succeeded", startedAt: NOW - 5_000, endedAt: NOW })]);
    renderHome();

    const start = screen.getByRole("region", { name: "New investigation" });
    expect(within(start).getAllByRole("button")).toHaveLength(7);
    const recent = screen.getByRole("region", { name: "Recent runs" });
    expect(start.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("stays silent about runs in the browser build, where there are none", () => {
    freshDb();
    renderHome();
    expect(screen.queryByRole("region", { name: "Running" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Recent runs" })).toBeNull();
  });
});
