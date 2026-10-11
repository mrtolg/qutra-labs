import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { SessionSchema } from "@/domain/types";
import FocusPage from "./FocusPage";

/* #/sessions/focus with no running session used to be replaced by Projects,
   with nothing saying why. The address stays and the page says what is
   missing and where to start one. */

const T = 1_700_000_000_000;

function mount() {
  return render(
    <MemoryRouter initialEntries={["/sessions/focus"]}>
      <Routes>
        <Route path="/sessions/focus" element={<FocusPage />} />
        <Route path="/workspaces" element={<h1>Projects page</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  setDbForTesting(null);
});

describe("Focus page", () => {
  it("explains that no session is running instead of leaving for Projects", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    mount();

    expect(screen.getByRole("heading", { name: "No focus session is running" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to projects" })).toHaveAttribute(
      "href",
      "/workspaces",
    );
    expect(screen.queryByText("Projects page")).toBeNull();
  });

  it("keeps a running session's controls when its project is gone", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    getDb()
      .collection("sessions")
      .put(
        SessionSchema.parse({
          id: "s-1",
          workspaceId: "deleted-project",
          title: "Write the report",
          status: "active",
          startedAt: T,
          createdAt: T,
          updatedAt: T,
        }),
      );
    mount();

    expect(screen.getByRole("heading", { name: "Write the report" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End session" })).toBeInTheDocument();
  });
});
