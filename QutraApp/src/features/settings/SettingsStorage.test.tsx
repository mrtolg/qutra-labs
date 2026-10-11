import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { useUi } from "@/state/ui";
import { SettingsDialog } from "./SettingsDialog";

/* Records this version cannot read are kept aside, and Storage says how
   many. */

beforeAll(async () => {
  await import("./SettingsPanel");
}, 30_000);

beforeEach(() => {
  useUi.setState({ settingsSection: null, lastSettingsSection: "general" });
});

async function openStorage(storage: MemoryStorageAdapter) {
  setDbForTesting(new Database(storage));
  render(<SettingsDialog />);
  act(() => useUi.getState().openSettings("storage"));
  await screen.findByText("Database version");
}

describe("Settings › Storage", () => {
  it("says how many records were kept aside", async () => {
    const storage = new MemoryStorageAdapter();
    storage.write("tasks", JSON.stringify([{ totally: "broken" }]));
    await openStorage(storage);
    expect(screen.getByText("Records kept aside").closest(".setting-row")).toHaveTextContent("1");
  });

  it("has no such row while every record reads", async () => {
    await openStorage(new MemoryStorageAdapter());
    expect(screen.queryByText("Records kept aside")).toBeNull();
  });
});
