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
  /** How many identical messages this one stands for. */
  count?: number;
}

/** How long a toast stays; errors stay until dismissed. */
const PASSIVE_MS = 4_000;
const ACTIONABLE_MS = 7_000;
/** The most toasts on screen at once; the oldest give way. */
export const MAX_TOASTS = 3;

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
  /** Holds a toast's countdown while it is hovered or focused. */
  pauseToast(id: number): void;
  resumeToast(id: number): void;
  announce(message: string): void;
}

let toastId = 0;

interface Countdown {
  timer: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
}
const countdowns = new Map<number, Countdown>();

function clearCountdown(id: number) {
  const c = countdowns.get(id);
  if (c?.timer) clearTimeout(c.timer);
  countdowns.delete(id);
}

function sameMessage(a: Omit<Toast, "id">, b: Toast): boolean {
  return (
    a.kind === b.kind &&
    a.messageKey === b.messageKey &&
    a.message === b.message &&
    a.actionKey === b.actionKey &&
    JSON.stringify(a.params ?? null) === JSON.stringify(b.params ?? null)
  );
}

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
    const current = get().toasts;
    // A repeat of a message already showing replaces it and counts up.
    const twin = current.find((x) => sameMessage(t, x));
    let next = current;
    let count = 1;
    if (twin) {
      count = (twin.count ?? 1) + 1;
      clearCountdown(twin.id);
      next = current.filter((x) => x.id !== twin.id);
    }
    next = [...next, { ...t, id, count }];
    while (next.length > MAX_TOASTS) {
      const [oldest, ...rest] = next;
      if (oldest) clearCountdown(oldest.id);
      next = rest;
    }
    set({ toasts: next });
    // Errors stay until the user dismisses them.
    if (t.kind !== "danger") {
      const ms = t.onAction ? ACTIONABLE_MS : PASSIVE_MS;
      countdowns.set(id, {
        remaining: ms,
        startedAt: Date.now(),
        timer: setTimeout(() => get().dismissToast(id), ms),
      });
    }
  },
  dismissToast: (id) => {
    clearCountdown(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  pauseToast: (id) => {
    const c = countdowns.get(id);
    if (!c?.timer) return;
    clearTimeout(c.timer);
    c.timer = null;
    c.remaining = Math.max(0, c.remaining - (Date.now() - c.startedAt));
  },
  resumeToast: (id) => {
    const c = countdowns.get(id);
    if (!c || c.timer) return;
    c.startedAt = Date.now();
    c.timer = setTimeout(() => get().dismissToast(id), c.remaining);
  },
  announce: (message) => set({ liveMessage: message }),
}));
