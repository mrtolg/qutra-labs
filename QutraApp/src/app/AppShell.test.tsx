import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { SkipToMainLink } from "./AppShell";

describe("skip-link", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = () => {};
  });

  it("keeps the hash-router location when activated", () => {
    window.history.replaceState(null, "", "/#/lab?e=E&view=scope");
    render(
      <>
        <SkipToMainLink />
        <main id="main" tabIndex={-1} />
      </>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Skip to main content" }));

    expect(window.location.hash).toBe("#/lab?e=E&view=scope");
    expect(document.getElementById("main")).toHaveFocus();
  });

  it("leaves the tab order while the overlay context panel covers #main", () => {
    // #main is inert under the overlay, so the link would go nowhere.
    window.innerWidth = 1100;
    const db = new Database(new MemoryStorageAdapter());
    db.prefs.set({ contextPanelOpen: true });
    setDbForTesting(db);
    render(<SkipToMainLink />);
    expect(screen.getByText("Skip to main content")).toHaveAttribute("inert");
  });
});
