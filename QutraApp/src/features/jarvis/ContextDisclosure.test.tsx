import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { ContextDisclosure } from "./ContextDisclosure";

let db: Database;
beforeEach(() => {
  db = new Database(new MemoryStorageAdapter());
  setDbForTesting(db);
});
afterEach(() => setDbForTesting(null));

describe("ContextDisclosure", () => {
  it("is only an icon when context is on but nothing would be attached, and the switch stays reachable", async () => {
    db.prefs.set({ assistantContextEnabled: true });
    render(<ContextDisclosure context={{ summary: [], truncated: false }} projectId="" />);
    const chip = screen.getByTestId("qutra-context");
    expect(chip).not.toHaveTextContent("Context attached");
    expect(chip).not.toHaveTextContent("0 items");
    expect(chip.querySelector("summary")).toHaveAttribute("aria-label", "Context");

    await userEvent.click(chip.querySelector("summary")!);
    expect(screen.getByTestId("qutra-context-toggle")).toBeChecked();
  });

  it("names the count when there are rows", () => {
    db.prefs.set({ assistantContextEnabled: true });
    render(
      <ContextDisclosure
        context={{ summary: [{ label: "project", value: "Lab" }], truncated: false }}
        projectId=""
      />,
    );
    expect(screen.getByTestId("qutra-context")).toHaveTextContent("Context attached (1 item");
  });

  it("says Context off when switched off", () => {
    db.prefs.set({ assistantContextEnabled: false });
    render(<ContextDisclosure context={{ summary: [], truncated: false }} projectId="" />);
    expect(screen.getByTestId("qutra-context")).toHaveTextContent("Context off");
  });
});
