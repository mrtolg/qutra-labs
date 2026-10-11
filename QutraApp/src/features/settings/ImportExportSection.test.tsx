import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { createEngagement } from "@/services/appService";
import { ImportExportSection } from "./ImportExportSection";

/* An import replaces everything the app holds, so it asks first. */

afterEach(() => setDbForTesting(null));

function otherDataAsFile(): File {
  const source = new Database(new MemoryStorageAdapter());
  setDbForTesting(source);
  createEngagement("From the file", "web");
  const json = source.exportAll();
  const file = new File([json], "backup.json", { type: "application/json" });
  // The test environment's File has no text().
  Object.defineProperty(file, "text", { value: async () => json });
  return file;
}

describe("importing from an export file", () => {
  it("replaces nothing until the dialog that asks is confirmed", async () => {
    const file = otherDataAsFile();
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    createEngagement("Mine", "pcap");
    const user = userEvent.setup();
    render(<ImportExportSection />);

    await user.upload(screen.getByLabelText("Import from export file"), file);
    const dialog = await screen.findByRole("dialog", { name: "Replace your data with this file?" });
    expect(dialog).toHaveTextContent("Importing “backup.json” replaces everything");
    // Nothing happened yet.
    expect(getDb().collection("engagements").getAll().map((e) => e.title)).toEqual(["Mine"]);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(getDb().collection("engagements").getAll().map((e) => e.title)).toEqual(["Mine"]);

    await user.upload(screen.getByLabelText("Import from export file"), file);
    const again = await screen.findByRole("dialog", { name: "Replace your data with this file?" });
    await user.click(within(again).getByRole("button", { name: "Replace and import" }));
    await waitFor(() =>
      expect(getDb().collection("engagements").getAll().map((e) => e.title)).toEqual(["From the file"]),
    );
  });
});
