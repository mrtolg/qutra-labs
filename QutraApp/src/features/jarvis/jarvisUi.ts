import { create } from "zustand";

/* The Jarvis screen's own state that the top bar's row shares: whether its
   settings drawer is open, and at which section. Kept apart from the page
   so the row loads none of the page's code. */

export type JarvisSettingsSection = "personal" | "memory" | "model" | "keys" | "data";

interface JarvisUiState {
  settings: JarvisSettingsSection | null;
  openSettings(section?: JarvisSettingsSection): void;
  closeSettings(): void;
}

export const useJarvisUi = create<JarvisUiState>((set, get) => ({
  settings: null,
  openSettings: (section) => set({ settings: section ?? get().settings ?? "personal" }),
  closeSettings: () => set({ settings: null }),
}));
