import { create } from "zustand";
import type { MessageKey } from "@/lib/i18n/en";

/* The companion's own state: whether its chat is open and what has been said
   in it. Memory only. The mini chat is never written to the conversations the
   Qutra page keeps, so closing the app or pressing Clear leaves nothing. */

export interface MiniMessage {
  role: "user" | "assistant";
  content: string;
}

/** Why the last question did not get an answer, kept as a cause (not words)
    so it is worded in the language shown at that moment. */
export type MiniFailure =
  | { kind: "assistant"; code: string }
  | { kind: "cloud"; error: unknown }
  | { kind: "refusal"; category: string | null }
  | { kind: "text"; key: MessageKey; params?: Record<string, string | number> };

/** The most messages the chat remembers and sends back with a question. */
export const MAX_MINI_MESSAGES = 12;

interface CompanionStore {
  open: boolean;
  messages: MiniMessage[];
  /** The answer so far while one is being written. */
  partial: string;
  busy: boolean;
  failure: MiniFailure | null;
  /** What is typed in the question box (kept when the chat closes). */
  draft: string;
  setOpen(open: boolean): void;
  setDraft(draft: string): void;
  clearChat(): void;
}

const fresh = () => ({
  messages: [] as MiniMessage[],
  partial: "",
  busy: false,
  failure: null as MiniFailure | null,
});

export const useCompanionStore = create<CompanionStore>((set) => ({
  open: false,
  ...fresh(),
  draft: "",
  setOpen: (open) => set({ open }),
  setDraft: (draft) => set({ draft }),
  clearChat: () => set({ ...fresh(), draft: "" }),
}));

export function resetCompanionForTesting(): void {
  useCompanionStore.setState({ open: false, ...fresh(), draft: "" });
}
