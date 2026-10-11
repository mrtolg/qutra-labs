import { create } from "zustand";
import type { TerminalShell } from "@/lib/bridge/terminal";

export type TerminalTabSpec =
  | { kind: "shell"; shell: TerminalShell }
  // `tool` names a *registered installation* by id, never a path or a
  // working directory: the Rust side (`terminal_open_tool`) resolves both
  // through the tool supervisor's identity gate
  // (`ToolSupervisor::resolve_launchable`), the same gate the batch Run
  // button and the detached GUI launch use. The renderer cannot supply
  // either on this route.
  | { kind: "tool"; installationId: string; args: string[] }
  // `attached` names a PTY session the broker already opened -- currently
  // only the assistant's `terminal_run` tool, when it had no existing
  // session to write to (`execute_terminal_run` in
  // `src-tauri/src/assistant/tools.rs` opens one via `terminal_open` and
  // returns its id as `StreamEvent.sessionId`). Unlike `shell`/`tool`, this
  // spec carries an *already-live* session id, not something for
  // `useTerminalSession` to open -- see `wireFromId` there, which binds a
  // surface to an existing session without opening one. Without this
  // variant that session had no tab, no listener ever kept its
  // `terminal://data` bytes, and it survived invisibly until app exit --
  // the exact "hidden `Command::new`" ADR 0012 Decision 1 promises this
  // design is not.
  | { kind: "attached"; sessionId: string };

export interface TerminalTab {
  id: string;
  title: string;
  spec: TerminalTabSpec;
  /** The PTY session this tab shows, once it is open (an attached tab knows
   * it from the start). Work reads Rust's facts for the active tab by it. */
  sessionId?: string;
}

interface TerminalTabsState {
  tabs: TerminalTab[];
  activeId: string | null;
  /**
   * First visit (and a fresh Private Lab grant) may seed one shell so the
   * page is not an empty strip. Stop-all, Private Lab revoke, and a
   * Terminal error-boundary death turn this off: those are explicit ends,
   * not "please open another". `openShellTab` from the + button still
   * works; it does not consult this flag.
   */
  reseedAllowed: boolean;
  openShellTab: (shell?: TerminalShell, title?: string) => string;
  openToolTab: (opts: { installationId: string; args: string[]; title: string }) => string;
  /** Open a tab for a session the broker already opened elsewhere (see the
   * `attached` spec doc above). Returns the *tab* id (a fresh one, like the
   * other `open*Tab` actions) -- not `sessionId`, which the caller already
   * has and the spec carries. */
  openAttachedTab: (opts: { sessionId: string; title: string }) => string;
  /** Record the session a tab's surface opened or attached to. A tab that
   * was closed in the meantime is not brought back. */
  bindSession: (tabId: string, sessionId: string) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  /** Drop every tab record and refuse auto-reseed. Native close is the
   * caller's job (`closeManagedTerminals`). */
  invalidateAll: () => void;
  allowReseed: () => void;
}

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random()}`;

export const useTerminalTabs = create<TerminalTabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  reseedAllowed: true,
  openShellTab: (shell = "pwsh", title) => {
    const id = newId();
    const tab: TerminalTab = {
      id,
      title: title ?? shell,
      spec: { kind: "shell", shell },
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
    return id;
  },
  openToolTab: ({ installationId, args, title }) => {
    const id = newId();
    const tab: TerminalTab = {
      id,
      title,
      spec: { kind: "tool", installationId, args },
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
    return id;
  },
  openAttachedTab: ({ sessionId, title }) => {
    // One tab per PTY. The agent reuses a session across steps -- the tool
    // schema invites it to, and the tool result hands it the id -- so a
    // multi-step turn reports the same `sessionId` more than once. Opening a
    // second tab for it would be worse than untidy: closing either one kills
    // the PTY (dispose-on-unmount, the same rule every other tab follows),
    // leaving the survivor displaying a session that is already dead.
    const existing = get().tabs.find(
      (t) => t.spec.kind === "attached" && t.spec.sessionId === sessionId,
    );
    if (existing) {
      set({ activeId: existing.id });
      return existing.id;
    }

    const id = newId();
    const tab: TerminalTab = {
      id,
      title,
      spec: { kind: "attached", sessionId },
      sessionId,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
    return id;
  },
  bindSession: (tabId, sessionId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || tab.sessionId === sessionId) return;
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, sessionId } : t)),
    }));
  },
  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (s.activeId === id) {
        const prev = tabs[Math.max(0, idx - 1)];
        activeId = prev ? prev.id : null;
      }
      return { tabs, activeId };
    }),
  setActive: (id) => set({ activeId: id }),
  invalidateAll: () => set({ tabs: [], activeId: null, reseedAllowed: false }),
  allowReseed: () => set({ reseedAllowed: true }),
}));
