import { create } from "zustand";
import type { MessageKey } from "@/lib/i18n/en";
import type { SettingsSection } from "@/features/settings/sections";

export interface Toast {
  id: number;
  kind: "success" | "danger" | "info";
  messageKey?: MessageKey;
  message?: string;
  params?: Record<string, string | number>;
  actionKey?: MessageKey;
  onAction?: () => void;
}

interface UiState {
  paletteOpen: boolean;
  activeWorkspaceId: string | null;
  toasts: Toast[];
  liveMessage: string;
  /** The open Settings section; null while the Settings modal is closed. */
  settingsSection: SettingsSection | null;
  lastSettingsSection: SettingsSection;

  setPaletteOpen(open: boolean): void;
  /** Opens the Settings modal over the current surface (docs/design/shell-spec.md §3):
      at `section`, else where it was last left. */
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  setActiveWorkspace(id: string | null): void;
  toast(t: Omit<Toast, "id">): void;
  dismissToast(id: number): void;
  announce(message: string): void;
}

let toastId = 0;

export const useUi = create<UiState>((set, get) => ({
  paletteOpen: false,
  activeWorkspaceId: null,
  toasts: [],
  liveMessage: "",
  settingsSection: null,
  lastSettingsSection: "general",

  setPaletteOpen: (open) => set({ paletteOpen: open }),
  openSettings: (section) => {
    const next = section ?? get().lastSettingsSection;
    set({ settingsSection: next, lastSettingsSection: next });
  },
  closeSettings: () => set({ settingsSection: null }),
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  toast: (t) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { ...t, id }] });
    // Actionable and error messages stay until the user dismisses them.
    if (!t.onAction && t.kind !== "danger") {
      setTimeout(() => get().dismissToast(id), 4000);
    }
  },
  dismissToast: (id) =>
    set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  announce: (message) => set({ liveMessage: message }),
}));
