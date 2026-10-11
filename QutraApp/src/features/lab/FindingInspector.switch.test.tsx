import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { FindingSchema } from "@/domain/findings";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { FindingInspector } from "./inspectors";

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  const db = getDb();
  for (const id of ["fnd_1", "fnd_2"] as const) {
    db.collection("findings").put(
      FindingSchema.parse({
        id,
        engagementId: "eng_1",
        title: id === "fnd_1" ? "Open port" : "Weak cipher",
        severity: "low",
        status: "new",
        fingerprint: `manual:${id}`,
        firstSeen: 1,
        lastSeen: 1,
        history: [{ at: 1, to: "new" }],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
  }
});

afterEach(() => setDbForTesting(null));

describe("FindingInspector when the open finding changes", () => {
  it("clears the evidence draft and returns to Overview", async () => {
    const { rerender } = render(
      <MemoryRouter>
        <FindingInspector id="fnd_1" />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "notes for finding A");
    expect(box).toHaveValue("notes for finding A");

    rerender(
      <MemoryRouter>
        <FindingInspector id="fnd_2" />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Weak cipher" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview", selected: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});
