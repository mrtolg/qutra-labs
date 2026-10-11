import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { ThemeStudio } from "@/features/settings/ThemeStudio";
import { AppearanceApplyBar } from "@/features/settings/AppearanceApplyBar";
import { useAppearanceDraft } from "@/lib/appearanceDraft";
import { useAppliedAppearance } from "./useAppliedAppearance";

/* Regression: pick a theme, see it behind Settings, press
   Apply, close Settings, and the old theme is back. The window must show the
   applied theme after Settings closes and after a reload. */

function osPrefersDark(dark: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("dark") ? dark : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** The app shell's appearance owner, and Settings › Appearance while open. */
function Shell({ studio }: { studio: boolean }) {
  useAppliedAppearance();
  return studio ? (
    <>
      <ThemeStudio />
      <AppearanceApplyBar />
    </>
  ) : null;
}

const root = document.documentElement;
let storage: MemoryStorageAdapter;

beforeEach(() => {
  osPrefersDark(true);
  delete root.dataset.pack;
  delete root.dataset.mode;
  useAppearanceDraft.setState({ draft: null });
  storage = new MemoryStorageAdapter();
  const db = new Database(storage);
  db.prefs.set({ theme: "system", packId: "hud", themeMode: "dark" });
  setDbForTesting(db);
});

afterEach(() => {
  setDbForTesting(null);
});

async function applyCatppuccin() {
  fireEvent.click(screen.getByRole("radio", { name: /Catppuccin/ }));
  expect(root.dataset.pack).toBe("catppuccin");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
  });
}

describe("applying a theme", () => {
  it("keeps the applied theme on the window after Settings closes", async () => {
    const view = render(<Shell studio />);
    expect(root.dataset.pack).toBe("hud");
    await applyCatppuccin();
    expect(getDb().prefs.get().packId).toBe("catppuccin");

    view.rerender(<Shell studio={false} />);
    expect(root.dataset.pack).toBe("catppuccin");
  });

  it("shows the applied theme after a reload", async () => {
    const view = render(<Shell studio />);
    await applyCatppuccin();
    view.unmount();

    delete root.dataset.pack;
    setDbForTesting(new Database(storage));
    render(<Shell studio={false} />);
    expect(root.dataset.pack).toBe("catppuccin");
  });

  it("drops an unapplied preview when Settings closes", () => {
    const view = render(<Shell studio />);
    fireEvent.click(screen.getByRole("radio", { name: /Catppuccin/ }));
    expect(root.dataset.pack).toBe("catppuccin");
    view.rerender(<Shell studio={false} />);
    expect(root.dataset.pack).toBe("hud");
    expect(getDb().prefs.get().packId).toBe("hud");
  });

  it("discards a preview from the Apply bar", () => {
    render(<Shell studio />);
    fireEvent.click(screen.getByRole("radio", { name: /Catppuccin/ }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(root.dataset.pack).toBe("hud");
    expect(screen.queryByRole("button", { name: /Apply/ })).toBeNull();
  });
});
