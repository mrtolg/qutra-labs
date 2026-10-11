import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import type { Preferences } from "@/domain/types";
import { useAppliedAppearance } from "@/app/useAppliedAppearance";
import { useAppearanceDraft } from "@/lib/appearanceDraft";
import { ThemeStudio } from "./ThemeStudio";

/* The studio previews its draft on the whole window while it is open, so the
   draft has to start as exactly what the window shows. resolveMode reads the
   legacy `theme: "light" | "dark"` before themeMode; a draft that ignored it
   flipped a dark window to the OS scheme the moment a pack was tried. */

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

function Shell() {
  useAppliedAppearance();
  return <ThemeStudio />;
}

function mount(prefs: Partial<Preferences>) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set(prefs);
  setDbForTesting(db);
  return render(<Shell />);
}

const tryPack = (name: RegExp) => fireEvent.click(screen.getByRole("radio", { name }));
const root = document.documentElement;

beforeEach(() => {
  delete root.dataset.mode;
  delete root.dataset.theme;
  useAppearanceDraft.setState({ draft: null });
});

afterEach(() => {
  setDbForTesting(null);
});

describe("Theme Studio preview", () => {
  it("keeps the legacy dark mode the window already shows", () => {
    osPrefersDark(false);
    mount({ theme: "dark", themeMode: "system", packId: "hud" });
    tryPack(/Catppuccin/);
    expect(root.dataset.mode).toBe("dark");
    expect(root.dataset.pack).toBe("catppuccin");
  });

  it("keeps the legacy light mode on a dark OS", () => {
    osPrefersDark(true);
    mount({ theme: "light", themeMode: "system", packId: "hud" });
    tryPack(/Qutra Labs/);
    expect(root.dataset.mode).toBe("light");
  });

  it("follows themeMode when no legacy mode is stored", () => {
    osPrefersDark(true);
    mount({ theme: "contextos", themeMode: "light", packId: "hud" });
    tryPack(/Catppuccin/);
    expect(root.dataset.mode).toBe("light");
  });

  it("offers no window effects", () => {
    osPrefersDark(true);
    mount({ packId: "hud", material: "mica" });
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.queryByText(/Mica|Acrylic|Liquid Glass/)).toBeNull();
    expect(root.dataset.nativeBackdrop).toBeUndefined();
  });

  it("moves between packs with the arrow keys", () => {
    osPrefersDark(true);
    mount({ packId: "hud" });
    fireEvent.keyDown(screen.getByRole("radio", { name: /HUD/ }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: /Qutra Labs/ })).toHaveAttribute("aria-checked", "true");
    expect(root.dataset.pack).toBe("contextos");
  });
});
