import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { GeneralSection } from "./GeneralSection";

beforeEach(() => setDbForTesting(new Database(new MemoryStorageAdapter())));
afterEach(() => setDbForTesting(null));

describe("Settings › General", () => {
  it("keeps the form of address as typed, spaces included", async () => {
    render(<GeneralSection />);

    const field = screen.getByLabelText("How should I address you?");
    expect(field).toHaveValue("");
    await userEvent.type(field, "Mert Bey");

    expect(getDb().prefs.get().addressAs).toBe("Mert Bey");
    expect(field).toHaveValue("Mert Bey");
  });

  it("shows what is stored and lets it be emptied", async () => {
    getDb().prefs.set({ addressAs: "efendim" });
    render(<GeneralSection />);

    const field = screen.getByLabelText("How should I address you?");
    expect(field).toHaveValue("efendim");
    await userEvent.clear(field);

    expect(getDb().prefs.get().addressAs).toBe("");
  });
});
