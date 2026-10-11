import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting } from "@/lib/bridge";
import type { InvestigationFile } from "@/lib/investigationFiles";
import { createEngagement } from "@/services/appService";
import { useInvestigationFiles } from "@/state/investigationFiles";
import { resetRuntime } from "@/test/labFixtures";
import LabPage from "./LabPage";

/* A new engagement left the user asking "I opened it, so what now?".
   Its Overview opens with the steps from scope to remediation
   (the old Methodology road folded in, spec 2026-10-07 §5.1), each with the
   button that does it, worded as what to do: the methodology's
   "Authorization scope defined" read as done when it was not. And with no
   findings at all the evidence panel said every finding had evidence. */

function Where() {
  const { search } = useLocation();
  return <output data-testid="where">{search}</output>;
}

function renderOverview(kind?: Parameters<typeof createEngagement>[1]) {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  const id = createEngagement("Home lab", kind);
  render(
    <MemoryRouter initialEntries={[`/lab?e=${id}&view=overview`]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LabPage />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return id;
}

const params = () => new URLSearchParams(screen.getByTestId("where").textContent ?? "");
const start = () => screen.getByRole("region", { name: "What to do next" });

const file = (engagementId: string): InvestigationFile => ({
  id: "file_1",
  engagementId,
  relPath: "files/invoice.pdf",
  name: "invoice.pdf",
  originalName: "invoice.pdf",
  bytes: 10,
  sha256: "ab".repeat(32),
  sha1: "cd".repeat(20),
  md5: "ef".repeat(16),
  kind: "pdf",
  sample: false,
  source: "picked",
  addedAt: 1,
  missing: false,
  readOnly: true,
});

afterEach(() => {
  resetRuntime();
  resetBridgeForTesting();
  useInvestigationFiles.setState({ byEngagement: {}, loadState: {} });
});

describe("Lab overview", () => {
  it("opens a new investigation with the road from scope to remediation", () => {
    renderOverview();

    expect(
      within(start()).getByText("“Home lab” is ready. These steps take it from scope to remediation."),
    ).toBeInTheDocument();
    expect(within(start()).getByText("0 of 6 steps complete")).toBeInTheDocument();
    expect(
      within(start())
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      "Define the scope Next",
      "Add targets Pending",
      "Run a scan Pending",
      "Record findings Pending",
      "Keep evidence Pending",
      "Write the remediation Pending",
    ]);
    expect(within(start()).queryByText("Authorization scope defined")).toBeNull();
  });

  it("each step opens the section where it is done", () => {
    const id = renderOverview();

    fireEvent.click(within(start()).getByRole("button", { name: "Add a target" }));
    expect(params().get("view")).toBe("targets");
    expect(params().get("e")).toBe(id);
  });

  it("marks a finished step done and drops its button", async () => {
    const id = renderOverview();
    const engagement = getDb().collection("engagements").get(id)!;
    const scope = getDb().collection("authorizationScopes").get(engagement.scopeId!)!;
    getDb()
      .collection("authorizationScopes")
      .put({ ...scope, testerAck: true, allowedTargets: ["10.0.0.0/24"] });

    expect(
      await within(start()).findByRole("heading", { name: "Define the scope Done" }),
    ).toBeInTheDocument();
    expect(within(start()).queryByRole("button", { name: "Open Scope" })).toBeNull();
    expect(within(start()).getByRole("button", { name: "Add a target" })).toBeInTheDocument();
  });

  it("says there are no findings yet instead of claiming all have evidence", () => {
    renderOverview();
    const evidence = screen.getByRole("region", { name: "Findings needing evidence" });

    expect(within(evidence).getByText("No findings yet.")).toBeInTheDocument();
    expect(within(evidence).queryByText("Every finding has evidence attached.")).toBeNull();
  });

  it("words the second step as files for a file investigation", () => {
    const id = renderOverview("file");

    expect(
      within(start())
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent)[1],
    ).toBe("Add your files Pending");
    fireEvent.click(within(start()).getByRole("button", { name: "Add files" }));
    expect(params().get("view")).toBe("targets");
    expect(params().get("add")).toBe("file");
    expect(params().get("e")).toBe(id);
  });

  it("counts a file as done for the second step, though there is no target", () => {
    const id = renderOverview("pcap");
    expect(within(start()).getByText("0 of 6 steps complete")).toBeInTheDocument();

    act(() => useInvestigationFiles.setState({ byEngagement: { [id]: [file(id)] } }));

    expect(within(start()).getByText("1 of 6 steps complete")).toBeInTheDocument();
    expect(within(start()).getByRole("heading", { name: "Add your files Done" })).toBeInTheDocument();
  });

  it("keeps the targets wording for an investigation of an address", () => {
    renderOverview("host");

    expect(within(start()).getByRole("heading", { name: "Add targets Pending" })).toBeInTheDocument();
  });
});
