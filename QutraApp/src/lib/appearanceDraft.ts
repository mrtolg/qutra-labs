import { create } from "zustand";
import type { Preferences } from "@/domain/types";
import { migrateAppearanceIntent, type PackId } from "@/lib/appearance";
import type { ThemeMode } from "@/lib/theme";

/* The appearance being tried in Settings › Appearance before Apply.

   The window shows exactly one appearance, and only useAppliedAppearance puts
   it on the document root: the stored one, or this draft over it while
   Appearance is open. Nothing else writes the root's theme attributes, so
   closing Settings can never put back an appearance that was current when it
   opened (a reported bug, 2026-10-10: Apply, close, old theme back). */

export interface AppearanceDraft {
  packId: PackId;
  themeMode: ThemeMode;
  themeScheduleLightAt: string;
  themeScheduleDarkAt: string;
}

type StoredAppearance = Pick<
  Preferences,
  "theme" | "packId" | "themeMode" | "themeScheduleLightAt" | "themeScheduleDarkAt" | "highContrast"
>;

export const DEFAULT_APPEARANCE: AppearanceDraft = {
  packId: "hud",
  themeMode: "system",
  themeScheduleLightAt: "07:00",
  themeScheduleDarkAt: "19:00",
};

/** The stored appearance as a draft: what the window shows without one. */
export function draftFromPrefs(prefs: StoredAppearance): AppearanceDraft {
  // resolveMode reads a legacy `theme: "light" | "dark"` before themeMode.
  const themeMode: ThemeMode =
    prefs.theme === "light" || prefs.theme === "dark" ? prefs.theme : prefs.themeMode;
  return {
    packId: migrateAppearanceIntent(prefs).packId,
    themeMode,
    themeScheduleLightAt: prefs.themeScheduleLightAt,
    themeScheduleDarkAt: prefs.themeScheduleDarkAt,
  };
}

/** The preference fields Apply writes; the legacy `theme` stays coherent. */
export function draftToPrefs(draft: AppearanceDraft): Partial<Preferences> {
  const highContrast = draft.packId === "highContrast";
  return {
    packId: draft.packId,
    themeMode: draft.themeMode,
    themeScheduleLightAt: draft.themeScheduleLightAt,
    themeScheduleDarkAt: draft.themeScheduleDarkAt,
    highContrast,
    theme: highContrast ? "highContrast" : "contextos",
  };
}

export function sameAppearance(a: AppearanceDraft, b: AppearanceDraft): boolean {
  return (
    a.packId === b.packId &&
    a.themeMode === b.themeMode &&
    a.themeScheduleLightAt === b.themeScheduleLightAt &&
    a.themeScheduleDarkAt === b.themeScheduleDarkAt
  );
}

/** True when the draft would change what is stored. */
export function draftIsPending(draft: AppearanceDraft | null, prefs: StoredAppearance): boolean {
  return draft !== null && !sameAppearance(draft, draftFromPrefs(prefs));
}

interface AppearanceDraftState {
  draft: AppearanceDraft | null;
  setDraft: (draft: AppearanceDraft | null) => void;
}

export const useAppearanceDraft = create<AppearanceDraftState>((set) => ({
  draft: null,
  setDraft: (draft) => set({ draft }),
}));
