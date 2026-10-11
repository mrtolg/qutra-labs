import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { EvidenceSchema } from "@/domain/findings";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { EvidenceInspector } from "./inspectors";

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  getDb()
    .collection("evidence")
    .put(
      EvidenceSchema.parse({
        id: "ev_1",
        engagementId: "eng_1",
        title: "nmap snippet",
        kind: "output",
        source: "nmap",
        capturedAt: 1,
        createdAt: 1,
      }),
    );
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  setDbForTesting(null);
});

describe("EvidenceInspector delete", () => {
  it("records the removal as app activity with a translated label", async () => {
    render(
      <MemoryRouter>
        <EvidenceInspector id="ev_1" />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Delete evidence" }));

    const event = getDb().collection("events").get("ev-del-ev_1");
    expect(event).toMatchObject({
      type: "app_activity",
      label: "Evidence removed: nmap snippet",
    });
    expect(event?.type).not.toBe("permission_changed");
    expect(getDb().collection("evidence").get("ev_1")).toBeUndefined();
  });
});
