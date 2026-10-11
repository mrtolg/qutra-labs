import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { FindingSchema } from "@/domain/findings";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { FindingInspector } from "./inspectors";

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  getDb()
    .collection("findings")
    .put(
      FindingSchema.parse({
        id: "fnd_1",
        engagementId: "eng_1",
        title: "Open port",
        severity: "low",
        status: "new",
        fingerprint: "manual:fnd_1",
        firstSeen: 1,
        lastSeen: 1,
        history: [{ at: 1, to: "new" }],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
});

afterEach(() => setDbForTesting(null));

describe("FindingInspector add evidence", () => {
  it("does not create a second row when Add evidence is double-clicked", async () => {
    render(
      <MemoryRouter>
        <FindingInspector id="fnd_1" />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    await userEvent.type(screen.getByRole("textbox"), "same note");
    const button = screen.getByRole("button", { name: "Add evidence" });
    await userEvent.dblClick(button);

    await waitFor(() => expect(getDb().collection("evidence").getAll()).toHaveLength(1));
    expect(getDb().collection("evidence").getAll()[0]).toMatchObject({
      content: "same note",
      findingId: "fnd_1",
    });
  });
});
