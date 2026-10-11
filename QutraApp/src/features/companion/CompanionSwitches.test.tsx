import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { CompanionSettings } from "./CompanionSettings";

/* The switch in Settings › General, and the pages the bubble was hidden on. */

let adapter: MemoryStorageAdapter;
beforeEach(() => {
  adapter = new MemoryStorageAdapter();
  setDbForTesting(new Database(adapter));
});

describe("the switch in Settings", () => {
  it("is off to begin with, and turning it on is saved across a restart", async () => {
    render(<CompanionSettings />);
    const toggle = screen.getByRole("checkbox", { name: "Follow me" });
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);

    expect(toggle).toBeChecked();
    expect(getDb().prefs.get().companionEnabled).toBe(true);
    setDbForTesting(new Database(adapter));
    expect(getDb().prefs.get().companionEnabled).toBe(true);
  });

  it("lists the pages it was hidden on, each with a way back", async () => {
    getDb().prefs.set({ companionEnabled: true, companionHidden: ["lab", "terminal"] });
    render(<CompanionSettings />);

    await userEvent.click(screen.getByRole("button", { name: "Show again on Investigations" }));
    expect(getDb().prefs.get().companionHidden).toEqual(["terminal"]);
    await userEvent.click(screen.getByRole("button", { name: "Show again on Terminal" }));
    expect(getDb().prefs.get().companionHidden).toEqual([]);
    expect(screen.getByText(/None\./)).toBeInTheDocument();
  });

  it("says in plain words what it sees", () => {
    render(<CompanionSettings />);
    expect(screen.getByText(/never sees your screen/)).toBeInTheDocument();
  });
});
