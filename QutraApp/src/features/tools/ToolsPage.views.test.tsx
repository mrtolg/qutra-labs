import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { en } from "@/lib/i18n/en";
import { createEngagement } from "@/services/appService";
import { SubNav } from "@/app/SubNav";
import ToolsPage from "./ToolsPage";

/* Spec 2026-10-07 §5.1: one Tools area. `?view` picks the toolbox, the
   registered tools (run against one investigation) or a guide section, and
   every section keeps the investigation it was opened for (`?e`). */

// jsdom has no Element.scrollTo; the catalog scrolls its guide to the top.
Element.prototype.scrollTo = vi.fn();

function Where() {
  const { search } = useLocation();
  return <output data-testid="where">{search}</output>;
}

const params = () => new URLSearchParams(screen.getByTestId("where").textContent ?? "");

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/tools"
          element={
            <>
              <SubNav />
              <ToolsPage />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function freshDb() {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  getDb().prefs.set({ privateToolsEnabled: true });
}

/** An older investigation and a newer one; without `?e` the newer one wins. */
function twoInvestigations() {
  freshDb();
  const db = getDb();
  const older = createEngagement("Older audit");
  const newer = createEngagement("Newest audit");
  db.collection("engagements").put({ ...db.collection("engagements").get(older)!, updatedAt: 1_000 });
  db.collection("engagements").put({ ...db.collection("engagements").get(newer)!, updatedAt: 2_000 });
  return { older, newer };
}

const sections = () => screen.getByRole("navigation", { name: "Tools views" });

afterEach(() => setDbForTesting(null));

describe("Tools area", () => {
  it("runs the registered tools against the named investigation, not the newest", () => {
    const { older } = twoInvestigations();
    renderAt(`/tools?view=registered&e=${older}`);
    const line = screen.getByTestId("tools-investigation");
    expect(line).toHaveTextContent("Older audit");
    expect(line).not.toHaveTextContent("Newest audit");
  });

  it("keeps the investigation when the sub-bar opens another section and comes back", () => {
    const { older } = twoInvestigations();
    renderAt(`/tools?view=registered&e=${older}`);
    fireEvent.click(within(sections()).getByRole("button", { name: "Catalog" }));
    expect(params().get("view")).toBe("catalog");
    expect(params().get("e")).toBe(older);
    fireEvent.click(within(sections()).getByRole("button", { name: "Registered tools" }));
    expect(params().get("e")).toBe(older);
    expect(screen.getByTestId("tools-investigation")).toHaveTextContent("Older audit");
  });

  it("opens a playbook's first tool in the catalog, still in the same investigation", () => {
    const { older } = twoInvestigations();
    renderAt(`/tools?view=playbooks&e=${older}`);
    fireEvent.click(screen.getAllByRole("button", { name: "Inspect first tool" })[0]!);
    expect(params().get("view")).toBe("catalog");
    expect(params().get("e")).toBe(older);
    const guide = screen.getByRole("complementary", { name: "Usage guide" });
    expect(within(guide).getByRole("heading", { level: 3, name: "Gitleaks" })).toBeInTheDocument();
  });

  it("offers no registered tool without an investigation, only the way to start one", () => {
    freshDb();
    renderAt("/tools?view=registered");
    expect(screen.getByTestId("tools-investigation")).toHaveTextContent("No investigation yet");
    expect(screen.getByRole("link", { name: /New investigation/ })).toHaveAttribute("href", "/lab?new=1");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it.each([
    ["catalog", "lab.purpose.guides", true],
    ["playbooks", "lab.purpose.playbooks", false],
    ["datasets", "lab.purpose.datasets", false],
  ] as const)(
    "says what %s is for in its own line, and counts tools only in the catalog",
    (view, key, countsTools) => {
      freshDb();
      renderAt(`/tools?view=${view}`);
      expect(screen.getByText(en[key])).toBeInTheDocument();
      for (const other of ["lab.purpose.guides", "lab.purpose.playbooks", "lab.purpose.datasets"] as const) {
        if (other !== key) expect(screen.queryByText(en[other])).toBeNull();
      }
      expect(screen.queryByText("Catalog entries") !== null).toBe(countsTools);
    },
  );

  it("names the area in the page heading and the section in its own", () => {
    freshDb();
    renderAt("/tools?view=playbooks");
    expect(screen.getByRole("heading", { level: 1, name: "Tools" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Playbooks" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
