import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { grantCloudConsent, revokeCloudConsent } from "@/lib/cloudConsent";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { createEngagement } from "@/services/appService";
import { useUi } from "@/state/ui";
import LabPage from "./LabPage";

/* Starting an engagement was one click that made one
   called "New engagement", so the list filled with identical names, the name
   could not visibly be changed, and nothing said what had happened. Now the
   Lab asks for the name first, the heading renames it, and the switch tells
   engagements apart by when they were made and archives the ones not needed. */

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
const engagements = () => getDb().collection("engagements").getAll();

afterEach(() => setDbForTesting(null));

describe("Lab engagement switcher", () => {
  it("switches engagement and keeps the open view", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const first = createEngagement("Acme external");
    const second = createEngagement("Internal wiki");
    renderLab(`/lab?e=${first}&view=findings`);

    fireEvent.click(screen.getByRole("button", { name: /Investigations \(2\)/ }));
    const list = screen.getByRole("dialog", { name: "Switch investigation" });
    expect(within(list).getByRole("button", { name: /^Acme external/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    fireEvent.click(within(list).getByRole("button", { name: /^Internal wiki/ }));

    expect(params().get("e")).toBe(second);
    expect(params().get("view")).toBe("findings");
  });

  it("tells engagements with one name apart and archives the ones not needed", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const kept = createEngagement("New engagement");
    const extra = createEngagement("New engagement");
    renderLab(`/lab?e=${kept}`);

    fireEvent.click(screen.getByRole("button", { name: /Investigations \(2\)/ }));
    const list = screen.getByRole("dialog", { name: "Switch investigation" });
    expect(within(list).getAllByText(/^Created /)).toHaveLength(2);

    // The row that is not the open engagement: both were made in the same
    // instant, so their order in the list is not fixed.
    const other = within(list)
      .getAllByRole("listitem")
      .find((row) => !within(row).queryByRole("button", { current: true }))!;
    fireEvent.click(within(other).getByRole("button", { name: "Archive New engagement" }));
    expect(engagements().find((e) => e.id === extra)?.status).toBe("archived");
    expect(screen.getByRole("button", { name: /Investigations \(1\)/ })).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Archived (1)" }));
    fireEvent.click(within(list).getByRole("button", { name: "Restore New engagement" }));
    expect(engagements().find((e) => e.id === extra)?.status).toBe("planned");
  });

  it("restores an active investigation to active, not planned", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const kept = createEngagement("Acme external");
    const active = createEngagement("Live case");
    const record = getDb().collection("engagements").get(active)!;
    getDb()
      .collection("engagements")
      .put({ ...record, status: "active", updatedAt: record.updatedAt + 1 });
    renderLab(`/lab?e=${kept}`);

    fireEvent.click(screen.getByRole("button", { name: /Investigations \(2\)/ }));
    const list = screen.getByRole("dialog", { name: "Switch investigation" });
    fireEvent.click(within(list).getByRole("button", { name: "Archive Live case" }));
    fireEvent.click(within(list).getByRole("button", { name: "Archived (1)" }));
    fireEvent.click(within(list).getByRole("button", { name: "Restore Live case" }));

    expect(engagements().find((e) => e.id === active)?.status).toBe("active");
  });
});

describe("Clearing out empty engagements", () => {
  it("archives every untouched engagement but the open one, and Undo brings them back", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const open = createEngagement("New engagement");
    const empties = [createEngagement("New engagement"), createEngagement("New engagement")];
    const used = createEngagement("Acme external");
    const usedRecord = getDb().collection("engagements").get(used)!;
    getDb().collection("engagements").put({ ...usedRecord, notes: "Router and NAS" });
    renderLab(`/lab?e=${open}`);

    fireEvent.click(screen.getByRole("button", { name: /Investigations \(4\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Archive empty ones (2)" }));

    const status = (id: string) => engagements().find((e) => e.id === id)?.status;
    expect(empties.map(status)).toEqual(["archived", "archived"]);
    expect(status(open)).toBe("planned");
    expect(status(used)).toBe("planned");
  });

  it("puts back only the status on Undo, so an allowance revoked meanwhile stays revoked", async () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const open = createEngagement("New engagement");
    const empty = createEngagement("New engagement");
    createEngagement("New engagement");
    await grantCloudConsent(empty, { provider: "anthropic", host: "api.anthropic.com" });
    renderLab(`/lab?e=${open}`);

    fireEvent.click(screen.getByRole("button", { name: /Investigations \(3\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Archive empty ones (2)" }));
    expect(getDb().collection("engagements").get(empty)?.status).toBe("archived");

    await revokeCloudConsent(empty);
    act(() => useUi.getState().toasts.at(-1)!.onAction!());
    const restored = getDb().collection("engagements").get(empty)!;
    expect(restored.status).toBe("planned");
    expect(restored).not.toHaveProperty("cloudConsent");
  });
});

describe("Starting an engagement", () => {
  it("asks for a name, makes nothing until Create, then opens the new one", async () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    renderLab("/lab");

    fireEvent.click(screen.getByRole("button", { name: "New investigation" }));
    const dialog = screen.getByRole("dialog", { name: "New investigation" });
    expect(engagements()).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Give the investigation a name.");
    expect(engagements()).toEqual([]);

    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Home lab: internal range" },
    });
    fireEvent.change(within(dialog).getByLabelText("Short note (optional)"), {
      target: { value: "Router and NAS" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await screen.findByRole("heading", { level: 1, name: "Home lab: internal range" });
    const [made] = engagements();
    expect(made?.title).toBe("Home lab: internal range");
    expect(made?.notes).toBe("Router and NAS");
    expect(params().get("e")).toBe(made?.id);
    expect(params().get("view")).toBe("overview");
    expect(params().get("new")).toBeNull();
  });

  it("opens a file investigation on its first step: adding the file", async () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    renderLab("/lab?new=1&kind=file");

    const dialog = screen.getByRole("dialog", { name: "New investigation" });
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Suspicious invoice" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await screen.findByRole("heading", { level: 1, name: "Suspicious invoice" });
    expect(params().get("view")).toBe("targets");
    expect(params().get("add")).toBe("file");
    expect(screen.getByText("First step: add the file you want to examine.")).toBeInTheDocument();
  });

  it("renames from the heading and never falls back to a default name", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const id = createEngagement("Acme external");
    renderLab(`/lab?e=${id}`);

    expect(screen.getByRole("heading", { level: 1, name: "Acme external" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename Acme external" }));
    const input = screen.getByRole("textbox", { name: "Investigation title" });
    fireEvent.change(input, { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "Acme external — retest" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(engagements()[0]?.title).toBe("Acme external — retest");
    expect(
      screen.getByRole("heading", { level: 1, name: "Acme external — retest" }),
    ).toBeInTheDocument();
  });
});
