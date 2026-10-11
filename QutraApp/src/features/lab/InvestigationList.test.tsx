import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { createEngagement } from "@/services/appService";
import { FindingSchema } from "@/domain/findings";
import { useUi } from "@/state/ui";
import { SubNav } from "@/app/SubNav";
import LabPage from "./LabPage";

/* Every investigation in one sortable table. */

const T = 1_759_300_000_000;

function Where() {
  const { search } = useLocation();
  return <output data-testid="where">{search}</output>;
}

function renderList(path = "/lab?list=1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
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

function seed() {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  const db = getDb();
  const ids = {
    alpha: createEngagement("Alpha capture", "pcap"),
    bravo: createEngagement("Bravo portal", "web"),
    charlie: createEngagement("Charlie disk", "forensics"),
  };
  db.collection("engagements").patch(ids.alpha, { status: "paused", updatedAt: T + 3 });
  db.collection("engagements").patch(ids.bravo, { status: "active", updatedAt: T + 2 });
  db.collection("engagements").patch(ids.charlie, { status: "archived", updatedAt: T + 1 });
  db.collection("findings").put(
    FindingSchema.parse({
      id: "f-1",
      engagementId: ids.bravo,
      title: "Admin panel open",
      severity: "critical",
      fingerprint: "fp-1",
      firstSeen: T,
      lastSeen: T,
      createdAt: T,
      updatedAt: T,
    }),
  );
  return ids;
}

const names = () =>
  within(screen.getByRole("table")).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("link")[0]!.textContent);

afterEach(() => {
  setDbForTesting(null);
  useUi.setState({ toasts: [] });
});

describe("Investigations list", () => {
  it("lists open investigations newest first, each opening itself", () => {
    const ids = seed();
    renderList();
    expect(screen.getByRole("heading", { level: 1, name: "All investigations" })).toBeInTheDocument();
    expect(names()).toEqual(["Alpha capture", "Bravo portal"]);
    expect(screen.getByRole("link", { name: "Bravo portal" })).toHaveAttribute(
      "href",
      `/lab?e=${ids.bravo}&view=overview`,
    );
    const bravo = screen.getByRole("link", { name: "Bravo portal" }).closest("tr")!;
    expect(bravo).toHaveTextContent("Active");
    expect(within(bravo).getByText("Open findings: 1 Critical")).toBeInTheDocument();
  });

  it("sorts by a column and says how", () => {
    seed();
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Open findings" }));
    expect(names()).toEqual(["Bravo portal", "Alpha capture"]);
    expect(screen.getByRole("columnheader", { name: /Open findings/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(names()).toEqual(["Alpha capture", "Bravo portal"]);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(names()).toEqual(["Bravo portal", "Alpha capture"]);
  });

  it("shows the archive on its own and filters by name", () => {
    seed();
    renderList();
    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    expect(names()).toEqual(["Charlie disk"]);
    fireEvent.click(screen.getByRole("button", { name: /^Open \d/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Find an investigation" }), {
      target: { value: "nothing like it" },
    });
    expect(screen.getByText("No investigation matches.")).toHaveAttribute("role", "status");
  });

  it("archives with one click and puts it back with Undo", () => {
    const ids = seed();
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Archive Alpha capture" }));
    expect(getDb().collection("engagements").get(ids.alpha)!.status).toBe("archived");
    expect(names()).toEqual(["Bravo portal"]);
    const toast = useUi.getState().toasts[0]!;
    expect(toast.messageKey).toBe("lab.list.archived");
    toast.onAction!();
    expect(getDb().collection("engagements").get(ids.alpha)!.status).toBe("paused");
  });

  it("restores an archived investigation to the state it had, not to planned", () => {
    const ids = seed();
    renderList();
    // Bravo is active; a plain restore (not Undo) must give it back as active.
    fireEvent.click(screen.getByRole("button", { name: "Archive Bravo portal" }));
    expect(getDb().collection("engagements").get(ids.bravo)!.status).toBe("archived");
    fireEvent.click(screen.getByRole("button", { name: /^Archived \d/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Bravo portal" }));
    const restored = getDb().collection("engagements").get(ids.bravo)!;
    expect(restored.status).toBe("active");
    expect(restored.statusBeforeArchive).toBeUndefined();
    // One archived before the state was kept has nothing to go back to.
    fireEvent.click(screen.getByRole("button", { name: /^Archived \d/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Charlie disk" }));
    expect(getDb().collection("engagements").get(ids.charlie)!.status).toBe("planned");
  });

  it("is the first entry of the Lab's row, current while listing", () => {
    seed();
    renderList();
    expect(screen.getByRole("button", { name: "All investigations" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("offers to start one when there are none", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    renderList();
    expect(screen.getByText("No investigations yet")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "New investigation" })[0]!);
    expect(new URLSearchParams(screen.getByTestId("where").textContent ?? "").get("new")).toBe("1");
  });
});
