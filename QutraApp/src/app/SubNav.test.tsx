import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { createEngagement } from "@/services/appService";
import { appendTurn, createConversation } from "@/lib/db/conversations";
import { useJarvisUi } from "@/features/jarvis/jarvisUi";
import { LAB_VIEW_DEFS } from "./workbench/navConfig";
import { SubNav } from "./SubNav";

/* One navigation bar. The side rail is gone; choosing an
   area in the top bar shows that area's sections in this row. */

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <SubNav />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId("where").textContent;
const tabs = (name: string) =>
  within(screen.getByRole("navigation", { name }))
    .getAllByRole("button")
    .map((b) => b.textContent);
const current = (name: string) =>
  within(screen.getByRole("navigation", { name }))
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-current") === "page")
    .map((b) => b.textContent);

afterEach(() => {
  setDbForTesting(null);
  vi.restoreAllMocks();
});

describe("SubNav", () => {
  it("shows Home's sections on Home pages", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    renderAt("/workspaces/ws-1");
    expect(tabs("Home sections")).toEqual(["Home", "Projects", "Files", "GitHub"]);
    expect(current("Home sections")).toEqual(["Projects"]);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(where()).toBe("/files");
  });

  it("shows the Tools area's five sections", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    renderAt("/tools?view=catalog");
    expect(tabs("Tools views")).toEqual([
      "Toolbox",
      "Registered tools",
      "Catalog",
      "Playbooks",
      "Datasets",
    ]);
    expect(current("Tools views")).toEqual(["Catalog"]);
    fireEvent.click(screen.getByRole("button", { name: "Datasets" }));
    expect(where()).toBe("/tools?view=datasets");
  });

  it("starts a conversation about nothing when the empty one shown is about an investigation", async () => {
    const db = new Database(new MemoryStorageAdapter());
    setDbForTesting(db);
    const linked = await createConversation(db, { engagementId: "eng-1", now: 1 });
    renderAt("/jarvis");

    fireEvent.click(screen.getAllByRole("button", { name: "New conversation" }).at(-1)!);
    await waitFor(() => expect(db.collection("conversations").getAll()).toHaveLength(2));
    const fresh = db.collection("conversations").getAll().find((c) => c.id !== linked.id)!;
    expect(fresh.engagementId).toBeNull();
  });

  it("gives the Terminal area its one section", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    renderAt("/terminal");
    expect(tabs("Terminal views")).toEqual(["Terminal"]);
  });

  it("acts on the Jarvis page: shows or hides its history, opens its settings, starts one empty conversation", async () => {
    const db = new Database(new MemoryStorageAdapter());
    setDbForTesting(db);
    useJarvisUi.setState({ settings: null });
    const first = await createConversation(db, { now: 1 });
    await appendTurn(db, {
      conversationId: first.id,
      expectedEraseRevision: 0,
      requestId: "r1",
      messages: [{ role: "user", content: "Recon planning" }],
      now: 2,
    });
    renderAt("/jarvis");
    // The conversations are in the page's history panel, not in this row.
    expect(screen.queryByRole("button", { name: "Recon planning" })).toBeNull();

    const history = screen.getByRole("button", { name: "History" });
    expect(history).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(history);
    expect(db.prefs.get().jarvisHistoryOpen).toBe(false);
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Jarvis settings" }));
    expect(useJarvisUi.getState().settings).toBe("personal");

    const startNew = () => screen.getAllByRole("button", { name: "New conversation" }).at(-1)!;
    fireEvent.click(startNew());
    await waitFor(() => expect(db.collection("conversations").getAll()).toHaveLength(2));
    // While the new one is still empty, another click makes nothing more.
    fireEvent.click(startNew());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(db.collection("conversations").getAll()).toHaveLength(2);
  });

  it("puts the investigation's sections here, with their counts, keeping the investigation", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const id = createEngagement("Home lab");
    getDb()
      .collection("targets")
      .put({
        id: "tg-1",
        engagementId: id,
        raw: "10.0.0.5",
        normalized: "10.0.0.5",
        kind: "ip",
        scopeState: "unknown",
        notes: "",
        demo: false,
        createdAt: 1,
        updatedAt: 1,
      });
    renderAt(`/lab?e=${id}&view=runs`);

    // The row names the engagement its views belong to.
    expect(screen.getByRole("button", { name: "Home lab" })).toBeInTheDocument();
    const views = screen.getByRole("navigation", { name: "Home lab: investigation sections" });
    expect(within(views).getAllByRole("button")).toHaveLength(LAB_VIEW_DEFS.length);
    expect(current("Home lab: investigation sections")).toEqual(["Runs"]);
    expect(within(views).getByRole("button", { name: /Targets/ })).toHaveTextContent("1");

    fireEvent.click(within(views).getByRole("button", { name: /Findings/ }));
    expect(where()).toBe(`/lab?e=${id}&view=findings`);
  });

  it("offers the open investigation's Import at its right end; the report is a section", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const id = createEngagement("Home lab");
    renderAt(`/lab?e=${id}`);
    expect(screen.queryByRole("button", { name: "Export report" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Import scan output" }));
    expect(where()).toBe(`/lab?e=${id}&view=findings&focus=import`);
  });

  it("has nothing to act on in Investigations before there is one", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    renderAt("/lab");
    expect(screen.queryByRole("button", { name: "Import scan output" })).toBeNull();
    for (const view of within(screen.getByRole("navigation", { name: "Investigation views" })).getAllByRole(
      "button",
    )) {
      expect(view).toBeDisabled();
    }
  });
});
