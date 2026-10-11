import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { useUi } from "@/state/ui";
import { SettingsDialog } from "./SettingsDialog";

function renderWithOpener() {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  return render(
    <>
      <button type="button" onClick={() => useUi.getState().openSettings()}>
        Opener
      </button>
      <SettingsDialog />
    </>,
  );
}

const dialog = () => document.querySelector("dialog.settings-dialog");

// The panel is a lazy chunk. Loading it once here keeps its transform time,
// which grows when the whole suite runs in parallel, out of the 1 s waits below.
beforeAll(async () => {
  await import("./SettingsPanel");
}, 30_000);

beforeEach(() => {
  useUi.setState({ settingsSection: null, lastSettingsSection: "general" });
});

describe("SettingsDialog", () => {
  it("is absent until opened, then shows as a modal over the page", async () => {
    renderWithOpener();
    expect(dialog()).toBeNull();
    act(() => useUi.getState().openSettings("privacy"));
    expect(
      await screen.findByRole("heading", { name: "Privacy & exclusions" }),
    ).toBeInTheDocument();
    expect(dialog()).toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Saved on this device")).toBeInTheDocument();
  });

  it("moves between sections inside the modal", async () => {
    renderWithOpener();
    act(() => useUi.getState().openSettings("general"));
    fireEvent.click(await screen.findByRole("button", { name: "Shortcuts" }));
    expect(useUi.getState().settingsSection).toBe("shortcuts");
    expect(
      await screen.findByRole("heading", { name: "Shortcuts" }),
    ).toBeInTheDocument();
  });

  it("opens the next section at the top after scrolling the previous section", async () => {
    renderWithOpener();
    act(() => useUi.getState().openSettings("general"));
    await screen.findByRole("heading", { name: "General" });
    const pane = document.querySelector<HTMLElement>(".settings-pane")!;
    pane.scrollTop = 600;
    fireEvent.click(screen.getByRole("button", { name: "Privacy & exclusions" }));
    await screen.findByRole("heading", { name: "Privacy & exclusions" });
    expect(document.querySelector<HTMLElement>(".settings-pane")!.scrollTop).toBe(0);
  });

  it("closes on Escape and returns focus to the opener", async () => {
    renderWithOpener();
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByLabelText("Search settings");
    expect(document.activeElement).toBe(screen.getByLabelText("Search settings"));

    // A native modal dialog turns Escape into a `cancel` event.
    fireEvent(dialog()!, new Event("cancel", { cancelable: true }));
    expect(useUi.getState().settingsSection).toBeNull();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes from its Close button and reopens where it was left", async () => {
    renderWithOpener();
    act(() => useUi.getState().openSettings("about"));
    fireEvent.click(await screen.findByRole("button", { name: /Close/ }));
    expect(dialog()).toBeNull();
    act(() => useUi.getState().openSettings());
    expect(useUi.getState().settingsSection).toBe("about");
  });
});
