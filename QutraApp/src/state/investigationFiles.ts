import { create } from "zustand";
import {
  investigationFiles,
  type AddOutcome,
  type InvestigationFile,
} from "@/lib/investigationFiles";

/* Each investigation's files as Rust keeps them. Nothing here is
   saved: Rust's record is the only one, read again whenever an investigation
   opens. Files are never removed here, so a list that arrives after
   a pick is merged with what the pick added, not swapped in for it. */

type LoadState = "loading" | "ready" | "failed";

interface InvestigationFilesState {
  /** Each investigation's files, newest first. */
  byEngagement: Record<string, InvestigationFile[]>;
  loadState: Record<string, LoadState>;
  /** The investigation the Lab shows: a drop on the window goes there. */
  dropTarget: string | null;
  /** True while files are dragged over the window. */
  dragOver: boolean;

  load(engagementId: string): Promise<void>;
  /** Opens the native picker. Rejects with Rust's reason (for example
      `no_engagement_folder`); resolves with one outcome per picked file. */
  pick(engagementId: string, title: string): Promise<AddOutcome[]>;
  addDropped(token: string, engagementId: string): Promise<AddOutcome[]>;
  setDropTarget(engagementId: string | null): void;
  setDragOver(over: boolean): void;
}

function merged(current: readonly InvestigationFile[], incoming: readonly InvestigationFile[]) {
  const byId = new Map(current.map((file) => [file.id, file]));
  for (const file of incoming) byId.set(file.id, file);
  return [...byId.values()].sort((a, b) => b.addedAt - a.addedAt);
}

const copied = (outcomes: readonly AddOutcome[]) =>
  outcomes.flatMap((o) => (o.outcome === "failed" ? [] : [o.file]));

export const useInvestigationFiles = create<InvestigationFilesState>((set, get) => {
  const keep = (engagementId: string, files: readonly InvestigationFile[]) =>
    set({
      byEngagement: {
        ...get().byEngagement,
        [engagementId]: merged(get().byEngagement[engagementId] ?? [], files),
      },
    });
  const setLoadState = (engagementId: string, state: LoadState) =>
    set({ loadState: { ...get().loadState, [engagementId]: state } });

  return {
    byEngagement: {},
    loadState: {},
    dropTarget: null,
    dragOver: false,

    async load(engagementId) {
      if (!investigationFiles.available()) return;
      setLoadState(engagementId, "loading");
      try {
        keep(engagementId, await investigationFiles.list(engagementId));
        setLoadState(engagementId, "ready");
      } catch {
        setLoadState(engagementId, "failed");
      }
    },

    async pick(engagementId, title) {
      if (!investigationFiles.available()) return [];
      const outcomes = await investigationFiles.pick(engagementId, title);
      keep(engagementId, copied(outcomes));
      return outcomes;
    },

    async addDropped(token, engagementId) {
      if (!investigationFiles.available()) return [];
      const outcomes = await investigationFiles.addDropped(token, engagementId);
      keep(engagementId, copied(outcomes));
      return outcomes;
    },

    setDropTarget: (engagementId) => set({ dropTarget: engagementId }),
    setDragOver: (over) => set({ dragOver: over }),
  };
});
