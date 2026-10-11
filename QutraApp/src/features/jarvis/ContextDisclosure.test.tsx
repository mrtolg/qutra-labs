import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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
  it("shows no chip when context is on but nothing would be attached", () => {
    db.prefs.set({ assistantContextEnabled: true });
    render(<ContextDisclosure context={{ summary: [], truncated: false }} projectId="" />);
    expect(screen.queryByTestId("qutra-context")).not.toBeInTheDocument();
  });

  it("names the rows when there are some", () => {
    db.prefs.set({ assistantContextEnabled: true });
    render(
      <ContextDisclosure
        context={{ summary: [{ label: "project", value: "Lab" }], truncated: false }}
        projectId=""
      />,
    );
    expect(screen.getByTestId("qutra-context")).toHaveTextContent("1");
  });

  it("stays when switched off, so it can be switched back on", () => {
    db.prefs.set({ assistantContextEnabled: false });
    render(<ContextDisclosure context={{ summary: [], truncated: false }} projectId="" />);
    expect(screen.getByTestId("qutra-context")).toBeInTheDocument();
  });
});
