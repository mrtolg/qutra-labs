import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { CompanionSlot } from "./CompanionSlot";

beforeEach(() => setDbForTesting(new Database(new MemoryStorageAdapter())));

function renderSlot() {
  return render(
    <MemoryRouter initialEntries={["/overview"]}>
      <CompanionSlot />
    </MemoryRouter>,
  );
}

describe("the companion slot", { timeout: 15_000 }, () => {
  it("draws nothing while the companion is off, which is how it starts", () => {
    renderSlot();
    expect(getDb().prefs.get().companionEnabled).toBe(false);
    expect(screen.queryByTestId("companion")).not.toBeInTheDocument();
  });

  it("brings the bubble in once it is turned on, and takes it away when off", async () => {
    renderSlot();
    act(() => getDb().prefs.set({ companionEnabled: true }));
    // The chunk is fetched now, so the first appearance can take a moment.
    expect(await screen.findByTestId("companion-bubble", {}, { timeout: 8_000 })).toBeInTheDocument();

    act(() => getDb().prefs.set({ companionEnabled: false }));
    expect(screen.queryByTestId("companion-bubble")).not.toBeInTheDocument();
  });
});
