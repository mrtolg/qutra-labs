import { create } from "zustand";
import { getDb } from "@/lib/db/database";
import { toolLogos, type FetchedToolLogo } from "@/lib/toolLogos";

/* Fetched logos, by installation id, shared by every surface that shows a
   registered tool. `load` reads what Rust already recorded; `fetch` is the
   one network step, made only on the user's own action and only while the
   setting allows it. */

interface FetchedLogosState {
  byId: Record<string, FetchedToolLogo>;
  /** Installations being fetched right now. */
  pending: Record<string, true>;
  load(ids: readonly string[]): Promise<void>;
  /** Null when the setting is off, the build has no native side, or the
      attempt failed (offline): nothing was recorded. */
  fetch(id: string): Promise<FetchedToolLogo | null>;
}

export const useFetchedLogos = create<FetchedLogosState>((set, get) => ({
  byId: {},
  pending: {},
  async load(ids) {
    const unknown = ids.filter((id) => !get().byId[id]);
    if (!toolLogos.available() || unknown.length === 0) return;
    try {
      const views = await toolLogos.list(unknown);
      if (views.length === 0) return;
      set((state) => ({
        byId: {
          ...state.byId,
          ...Object.fromEntries(views.map((view) => [view.installationId, view])),
        },
      }));
    } catch {
      // Private Lab off or the store unreadable: letter tiles stay.
    }
  },
  async fetch(id) {
    if (!toolLogos.available() || !getDb().prefs.get().toolLogoFetch) return null;
    if (get().pending[id]) return null;
    set((state) => ({ pending: { ...state.pending, [id]: true } }));
    try {
      const view = await toolLogos.fetch(id);
      set((state) => ({ byId: { ...state.byId, [id]: view } }));
      return view;
    } catch {
      return null;
    } finally {
      set((state) => {
        const pending = { ...state.pending };
        delete pending[id];
        return { pending };
      });
    }
  },
}));
