import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { getBridge, resetBridgeForTesting } from "@/lib/bridge";
import { createEngagement } from "@/services/appService";
import { LAB_VIEW_DEFS } from "@/app/workbench/navConfig";
import { FindingSchema, EvidenceSchema } from "@/domain/findings";
import { resetRuntime, run, seedRuntime } from "@/test/labFixtures";
import { useLabRuntime } from "@/state/labRuntime";
import { SubNav } from "@/app/SubNav";
import LabPage from "./LabPage";

/* The Lab's views are a segmented control inside the
   surface, under an engagement header that states the scope. Finding, Evidence
   and Tool details open inside their own view instead of a side inspector. */

const T = 1_759_300_000_000;

function Where() {
  const { search } = useLocation();
  return <output data-testid="where">{search}</output>;
}

function renderLab(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {/* The Lab's views are its sub-tabs under the top bar. */}
              <SubNav />
              <LabPage />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const params = () => new URLSearchParams(screen.getByTestId("where").textContent ?? "");

function engagementWithScope(targets: string[] = []) {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  const id = createEngagement("Home lab");
  const db = getDb();
  const engagement = db.collection("engagements").get(id)!;
  const scope = db.collection("authorizationScopes").get(engagement.scopeId!)!;
  db.collection("authorizationScopes").put({
    ...scope,
    allowedTargets: ["192.168.56.0/24", "10.0.0.5"],
    excludedTargets: ["192.168.56.1"],
    authorizationRef: "AUTH-2026-014",
    testerAck: true,
  });
  for (const raw of targets) {
    db.collection("targets").put({
      id: `tg-${raw}`,
      engagementId: id,
      raw,
      normalized: raw,
      kind: "ip",
      scopeState: "unknown",
      notes: "",
      demo: false,
      createdAt: T,
      updatedAt: T,
    });
  }
  return id;
}

const realRefresh = useLabRuntime.getState().refresh;

afterEach(() => {
  resetRuntime();
  useLabRuntime.setState({ refresh: realRefresh });
  resetBridgeForTesting();
});

describe("Lab views", () => {
  it("are one segmented control inside the surface, in registry order", () => {
    const id = engagementWithScope();
    renderLab(`/lab?e=${id}&view=runs`);
    const views = screen.getByRole("navigation", { name: "Home lab: investigation sections" });
    const buttons = within(views).getAllByRole("button");
    expect(buttons).toHaveLength(LAB_VIEW_DEFS.length);
    expect(buttons[0]).toHaveTextContent("Overview");
    expect(
      buttons.filter((b) => b.getAttribute("aria-current") === "page").map((b) => b.textContent),
    ).toEqual(["Runs"]);
  });

  it("switch view by URL and keep the engagement", () => {
    const id = engagementWithScope();
    renderLab(`/lab?e=${id}&view=runs`);
    const views = screen.getByRole("navigation", { name: "Home lab: investigation sections" });
    fireEvent.click(within(views).getByRole("button", { name: /Findings/ }));
    expect(params().get("e")).toBe(id);
    expect(params().get("view")).toBe("findings");
  });
});

describe("Lab engagement header", () => {
  it("names the engagement in the page heading, with a way to rename it", () => {
    const id = engagementWithScope();
    renderLab(`/lab?e=${id}`);
    expect(screen.getByRole("heading", { level: 1, name: "Home lab" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename Home lab" }));
    expect(screen.getByRole("textbox", { name: "Investigation title" })).toHaveValue("Home lab");
  });

  it("shows the scope strip on every section and opens Scope from it", () => {
    const id = engagementWithScope(["10.0.0.5"]);
    renderLab(`/lab?e=${id}&view=runs`);
    const strip = screen.getByTestId("lab-scope-strip");
    expect(strip).toHaveTextContent("Scope validated");
    expect(strip).toHaveTextContent(
      "Allowed: 192.168.56.0/24, 10.0.0.5 · local and private addresses too · everything else is blocked",
    );
    fireEvent.click(strip);
    expect(params().get("view")).toBe("scope");
    expect(params().get("e")).toBe(id);
  });

  it("opens the list of every investigation for Home's All investigations link", () => {
    engagementWithScope();
    renderLab("/lab?switch=1");
    expect(screen.getByRole("dialog", { name: "Switch investigation" })).toHaveTextContent("Home lab");
  });

  it("opens the list when ?switch=1 arrives while the Lab is already open", () => {
    engagementWithScope();
    function Go() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate("/lab?switch=1")}>
          go
        </button>
      );
    }
    render(
      <MemoryRouter initialEntries={["/lab?view=report"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Go />
                <LabPage />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("dialog", { name: "Switch investigation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.getByRole("dialog", { name: "Switch investigation" })).toBeInTheDocument();
  });

  it("redirects the old Tools view to the Tools area", () => {
    const id = engagementWithScope();
    render(
      <MemoryRouter initialEntries={[`/lab?e=${id}&view=tools&tool=t-1`]}>
        <Routes>
          <Route path="/lab" element={<LabPage />} />
          <Route path="/tools" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(params().get("view")).toBe("registered");
    expect(params().get("e")).toBe(id);
    expect(params().get("tool")).toBe("t-1");
  });

  it("redirects the old Guides view to the catalog, still naming the investigation", () => {
    const id = engagementWithScope();
    render(
      <MemoryRouter initialEntries={[`/lab?e=${id}&view=guides`]}>
        <Routes>
          <Route path="/lab" element={<LabPage />} />
          <Route path="/tools" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(params().get("view")).toBe("catalog");
    expect(params().get("e")).toBe(id);
  });

  it("offers the way out when a target is out of scope", () => {
    const id = engagementWithScope(["8.8.8.8"]);
    renderLab(`/lab?e=${id}&view=evidence`);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Runs are blocked.");
    fireEvent.click(within(alert).getByRole("button", { name: "Open scope" }));
    expect(params().get("view")).toBe("scope");
  });

  it("has no Stop all runs while nothing of this engagement runs", () => {
    const id = engagementWithScope();
    seedRuntime([run({ engagementId: "other", state: "running" })]);
    renderLab(`/lab?e=${id}`);
    expect(screen.queryByRole("button", { name: "Stop all runs" })).toBeNull();
  });

  /* In the desktop app the count is a fact only after a good
     native read with Private Lab consent. Withdrawing consent gates listing
     but stops no process, so it proves no zero (same rule as Home). */
  const activeRunsStat = () => screen.getByTestId("lab-active-runs");

  it("does not claim zero active runs before the first native read", () => {
    const id = engagementWithScope();
    seedRuntime([]);
    useLabRuntime.setState({ ready: false });
    renderLab(`/lab?e=${id}`);
    expect(activeRunsStat()).toHaveTextContent("Reading runs…");
    expect(activeRunsStat()).not.toHaveTextContent("0");
  });

  it("states that runs could not be read and retries the read", async () => {
    const id = engagementWithScope();
    seedRuntime([]);
    const refresh = vi.fn().mockResolvedValue(undefined);
    useLabRuntime.setState({ readFailed: true, refresh });
    renderLab(`/lab?e=${id}`);
    expect(activeRunsStat()).toHaveTextContent("Runs could not be read");
    expect(activeRunsStat()).not.toHaveTextContent("0");
    await userEvent.click(within(activeRunsStat()).getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not read withdrawn consent as nothing running", () => {
    const id = engagementWithScope();
    seedRuntime([run({ engagementId: id, state: "running" })]);
    getDb().prefs.set({ privateToolsEnabled: false });
    renderLab(`/lab?e=${id}`);
    expect(activeRunsStat()).toHaveTextContent("Runs unknown while Private Lab is off");
    expect(activeRunsStat()).not.toHaveTextContent(/\d/);
  });

  it("states zero after a good, truly empty native read", () => {
    const id = engagementWithScope();
    seedRuntime([run({ engagementId: id, state: "succeeded" })]);
    renderLab(`/lab?e=${id}`);
    expect(activeRunsStat()).toHaveTextContent("0 active runs");
  });

  it("counts this engagement's active runs after a good native read", () => {
    const id = engagementWithScope();
    seedRuntime([
      run({ engagementId: id, state: "running" }),
      run({ engagementId: "other", state: "running" }),
    ]);
    renderLab(`/lab?e=${id}`);
    expect(activeRunsStat()).toHaveTextContent("1 active runs");
  });

  it("Stop all runs stops every active run of this engagement only", async () => {
    const id = engagementWithScope();
    const mine = [
      run({ engagementId: id, state: "running" }),
      run({ engagementId: id, state: "queued" }),
    ];
    seedRuntime([...mine, run({ engagementId: "other", state: "running" })]);
    const cancel = vi
      .spyOn(getBridge().toolSupervisor, "cancel")
      .mockResolvedValue(undefined as never);
    renderLab(`/lab?e=${id}`);
    await userEvent.click(screen.getByRole("button", { name: "Stop all runs" }));
    expect(cancel.mock.calls.map(([runId]) => runId).sort()).toEqual(
      mine.map((r) => r.id).sort(),
    );
  });
});

describe("Lab details inside their view", () => {
  function seedFinding(engagementId: string) {
    const db = getDb();
    db.collection("findings").put(
      FindingSchema.parse({
        id: "f-1",
        engagementId,
        title: "Exposed admin panel",
        severity: "high",
        fingerprint: "fp-1",
        firstSeen: T,
        lastSeen: T,
        createdAt: T,
        updatedAt: T,
      }),
    );
    db.collection("evidence").put(
      EvidenceSchema.parse({
        id: "ev-1",
        engagementId,
        kind: "output",
        title: "nmap output",
        capturedAt: T,
        createdAt: T,
      }),
    );
  }

  it("opens a finding in the Findings view, attaches evidence, and closes", async () => {
    const id = engagementWithScope();
    seedFinding(id);
    const user = userEvent.setup();
    renderLab(`/lab?e=${id}&view=findings`);

    await user.click(screen.getByText("Exposed admin panel"));
    expect(params().get("item")).toBe("f-1");
    const detail = screen.getByRole("region", { name: "Finding" });
    expect(within(detail).getByText("Exposed admin panel")).toBeInTheDocument();

    await user.click(within(detail).getByRole("tab", { name: "Evidence" }));
    await user.selectOptions(within(detail).getByRole("combobox"), "ev-1");
    expect(getDb().collection("findings").get("f-1")?.evidenceIds).toContain("ev-1");

    await user.click(within(detail).getByRole("button", { name: "Close" }));
    expect(params().get("item")).toBeNull();
    expect(screen.queryByRole("region", { name: "Finding" })).toBeNull();
  });

  it("marks a finding without evidence as a draft in the table", () => {
    const id = engagementWithScope();
    seedFinding(id);
    renderLab(`/lab?e=${id}&view=findings`);
    const table = screen.getByTestId("lab-findings");
    expect(within(table).getByText("Draft · no evidence")).toBeInTheDocument();

    act(() => {
      const db = getDb();
      db.collection("evidence").put({ ...db.collection("evidence").get("ev-1")!, findingId: "f-1" });
    });

    expect(within(table).queryByText("Draft · no evidence")).toBeNull();
  });

  it("deep-links an evidence record", () => {
    const id = engagementWithScope();
    seedFinding(id);
    renderLab(`/lab?e=${id}&view=evidence&item=ev-1`);
    const detail = screen.getByRole("region", { name: "Evidence" });
    expect(within(detail).getAllByText("nmap output").length).toBeGreaterThan(0);
  });

  it("drops the open detail when the view changes", () => {
    const id = engagementWithScope();
    seedFinding(id);
    renderLab(`/lab?e=${id}&view=findings&item=f-1`);
    const views = screen.getByRole("navigation", { name: "Home lab: investigation sections" });
    fireEvent.click(within(views).getByRole("button", { name: /Evidence/ }));
    expect(params().get("item")).toBeNull();
  });
});

describe("Lab overview", () => {
  it("counts findings by severity and opens the Findings view", () => {
    const id = engagementWithScope();
    getDb().collection("findings").put(
      FindingSchema.parse({
        id: "f-1",
        engagementId: id,
        title: "SMB signing not required",
        severity: "high",
        affectedTargets: ["192.168.56.101:445"],
        fingerprint: "fp-1",
        firstSeen: T,
        lastSeen: T,
        createdAt: T,
        updatedAt: T,
      }),
    );
    renderLab(`/lab?e=${id}&view=overview`);
    const severity = screen.getByRole("region", { name: /Findings by severity/ });
    expect(within(severity).getByText("High").previousSibling).toHaveTextContent("1");
    fireEvent.click(within(severity).getByRole("button", { name: "Open Findings" }));
    expect(params().get("view")).toBe("findings");
  });

  it("opens a finding that still needs evidence", () => {
    const id = engagementWithScope();
    getDb().collection("findings").put(
      FindingSchema.parse({
        id: "f-2",
        engagementId: id,
        title: "TLS 1.0 still accepted",
        severity: "medium",
        affectedTargets: ["192.168.56.104:443"],
        fingerprint: "fp-2",
        firstSeen: T,
        lastSeen: T,
        createdAt: T,
        updatedAt: T,
      }),
    );
    renderLab(`/lab?e=${id}&view=overview`);
    const needing = screen.getByRole("region", { name: /Findings needing evidence/ });
    fireEvent.click(within(needing).getByRole("button", { name: /TLS 1.0 still accepted/ }));
    expect(params().get("view")).toBe("findings");
    expect(params().get("item")).toBe("f-2");
  });

  it("lists this engagement's recent runs and opens Runs", () => {
    const id = engagementWithScope();
    seedRuntime([
      run({ engagementId: id, state: "succeeded", commandPreview: "nmap -sV 192.168.56.101" }),
      run({ engagementId: "other", state: "succeeded", commandPreview: "gitleaks detect" }),
    ]);
    renderLab(`/lab?e=${id}&view=overview`);
    const runs = screen.getByRole("region", { name: /Recent runs/ });
    expect(within(runs).getByText("nmap -sV 192.168.56.101")).toBeInTheDocument();
    expect(within(runs).queryByText("gitleaks detect")).toBeNull();
    fireEvent.click(within(runs).getByRole("button", { name: "Open Runs" }));
    expect(params().get("view")).toBe("runs");
  });
});

describe("Import scan output from the rail", () => {
  it("lands with the import field focused", () => {
    const id = engagementWithScope();
    renderLab(`/lab?e=${id}&view=findings&focus=import`);
    expect(screen.getByRole("textbox", { name: "Import scan output" })).toHaveFocus();
  });
});

describe("An imported scan as evidence", () => {
  const SARIF = JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "semgrep", rules: [] } },
        results: [
          {
            ruleId: "r.sqli",
            level: "error",
            message: { text: "Tainted input reaches a query" },
            locations: [
              { physicalLocation: { artifactLocation: { uri: "src/db.ts" }, region: { startLine: 4 } } },
            ],
          },
          { ruleId: "r.md5", level: "note", message: { text: "MD5 used" } },
        ],
      },
    ],
  });

  async function importScan(id: string, how: "paste" | "file" = "paste") {
    const user = userEvent.setup();
    const view = renderLab(`/lab?e=${id}&view=findings`);
    if (how === "paste") {
      fireEvent.change(screen.getByRole("textbox", { name: "Import scan output" }), {
        target: { value: SARIF },
      });
    } else {
      await user.upload(
        screen.getByLabelText("Load from a file"),
        new File([SARIF], "scan.sarif", { type: "application/json" }),
      );
      await screen.findByDisplayValue(SARIF);
    }
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(screen.getByRole("button", { name: "Commit import" }));
    await screen.findByTestId("lab-import-msg");
    view.unmount();
  }

  const of = (id: string) => ({
    findings: getDb().collection("findings").getAll().filter((f) => f.engagementId === id),
    evidence: getDb().collection("evidence").getAll().filter((e) => e.engagementId === id),
  });

  it("keeps the scan, named and hashed, as evidence for each finding it brings in", async () => {
    const id = engagementWithScope();
    await importScan(id, "file");

    const { findings, evidence } = of(id);
    expect(findings).toHaveLength(2);
    expect(evidence).toHaveLength(2);
    const { sha256Hex } = await import("@/lib/hash");
    for (const finding of findings) {
      const [row] = evidence.filter((e) => e.findingId === finding.id);
      expect(row).toMatchObject({
        kind: "file",
        title: "scan.sarif",
        sha256: await sha256Hex(SARIF),
        source: "import:sarif",
      });
      expect(finding.evidenceIds).toEqual([row!.id]);
    }
  });

  it("names pasted output, and keeps the same scan apart in two investigations", async () => {
    const first = engagementWithScope();
    const second = createEngagement("Second lab");
    await importScan(first);
    await importScan(second);

    expect(of(first).findings).toHaveLength(2);
    expect(of(second).findings).toHaveLength(2);
    expect(of(second).evidence.map((e) => e.title)).toEqual(["Pasted scan output", "Pasted scan output"]);
  });

  it("gives a draft its first evidence, and leaves a dismissed finding alone", async () => {
    const id = engagementWithScope();
    await importScan(id);
    const [first, second] = of(id).findings;
    const db = getDb();
    // One loses its evidence (a draft now); the other is dismissed.
    db.collection("evidence").remove(of(id).evidence.find((e) => e.findingId === first!.id)!.id);
    db.collection("findings").put({ ...second!, status: "false_positive" });

    await importScan(id);

    const { evidence } = of(id);
    expect(evidence.filter((e) => e.findingId === first!.id)).toHaveLength(1);
    expect(evidence.filter((e) => e.findingId === second!.id)).toHaveLength(1);
  });

  it("forgets the preview when the text is edited after it", async () => {
    const id = engagementWithScope();
    const user = userEvent.setup();
    renderLab(`/lab?e=${id}&view=findings`);
    const box = screen.getByRole("textbox", { name: "Import scan output" });
    fireEvent.change(box, { target: { value: SARIF } });
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("button", { name: "Commit import" })).toBeInTheDocument();

    fireEvent.change(box, { target: { value: `${SARIF} ` } });

    expect(screen.queryByRole("button", { name: "Commit import" })).toBeNull();
  });

  it("adds the scan to a finding it reopens, and to none that already has evidence", async () => {
    const id = engagementWithScope();
    await importScan(id);
    const [fixed] = of(id).findings;
    getDb().collection("findings").put({ ...fixed!, status: "mitigated" });

    await importScan(id);

    const { findings, evidence } = of(id);
    expect(findings.find((f) => f.id === fixed!.id)!.status).toBe("reopened");
    expect(evidence.filter((e) => e.findingId === fixed!.id)).toHaveLength(2);
    expect(evidence).toHaveLength(3);
  });
});
