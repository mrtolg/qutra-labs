import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { NewEngagementDialog } from "./NewEngagementDialog";

/* Spec 2026-10-07 §5.2: a Home tile opens this dialog with its kind chosen,
   and the investigation is saved with that kind. */

afterEach(() => setDbForTesting(null));

describe("NewEngagementDialog kind", () => {
  it("starts with the kind the tile chose and saves it", async () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const onCreated = vi.fn();
    render(<NewEngagementDialog open kind="pcap" onClose={() => {}} onCreated={onCreated} />);

    expect(screen.getByLabelText("What are you investigating?")).toHaveValue("pcap");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Office capture" } });
    fireEvent.click(screen.getByTestId("lab-create-submit"));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const [id] = onCreated.mock.calls[0]!;
    expect(getDb().collection("engagements").get(id)?.kind).toBe("pcap");
  });

  it("leaves the kind unset when none is chosen", async () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const onCreated = vi.fn();
    render(<NewEngagementDialog open onClose={() => {}} onCreated={onCreated} />);

    expect(screen.getByLabelText("What are you investigating?")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Notes" } });
    fireEvent.click(screen.getByTestId("lab-create-submit"));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const [id] = onCreated.mock.calls[0]!;
    expect(getDb().collection("engagements").get(id)?.kind).toBeUndefined();
  });
});
