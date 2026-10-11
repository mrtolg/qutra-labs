export type TerminalShell = "pwsh" | "powershell" | "bash";

export interface TerminalDataEvent {
  id: string;
  data: string;
  /** Cumulative byte count of this session's output as of and including
   * this chunk. Directly comparable to `TerminalScrollback.cursor` — see
   * that type and `wireFromId` (`useTerminalSession.ts`) for how a
   * newly-attaching surface uses the pair to replay backlog exactly once,
   * never twice and never with a gap. */
  seq: number;
}

/** A session's buffered output, for a surface attaching after some of it was
 * already produced. `cursor` is the same counter `TerminalDataEvent
 * .seq` carries — a live event with `seq > cursor` arrived after this
 * snapshot and must be applied; one with `seq <= cursor` is already inside
 * `text` and must not be replayed. */
export interface TerminalScrollback {
  text: string;
  cursor: number;
}

export interface ResolvedShellReport {
  program: string;
  kind: string;
}

/** How a session's shell process ended. `code` is the shell process's exit
 * code, never the last command's. */
export interface TerminalSessionExit {
  code: number;
  /** `stopped` when this app closed it; `natural` otherwise. */
  reason: "natural" | "stopped";
  /** Unix epoch milliseconds. */
  endedAt: number;
}

/** Rust-derived facts about one PTY session (data contracts §1, option A).
 * The process (`state`) and its output stream (`ioState`) are separate
 * facts: either can end first. `initialCwd` is where the process started,
 * never the shell's current directory. */
export interface TerminalSessionInfo {
  runtimeId: string;
  sessionId: string;
  /** Registry revision of this session's latest change. */
  revision: number;
  origin: "user" | "assistant" | "registered_tool";
  installationId: string | null;
  state: "running" | "stopping" | "exited" | "unknown";
  ioState: "open" | "closed" | "error";
  pid: number | null;
  /** File name only, never a path. */
  programName: string;
  /** Unix epoch milliseconds. */
  startedAt: number;
  /** Measured by Rust as of this snapshot; frozen once the process exited. */
  elapsedMs: number;
  initialCwd: string | null;
  cwdSource: "spawn" | "unknown";
  exit: TerminalSessionExit | null;
}

/** `terminal_list_sessions`: every session Rust still holds, and the
 * revision the snapshot covers. */
export interface TerminalSessionList {
  runtimeId: string;
  revision: number;
  sessions: TerminalSessionInfo[];
}

/** `terminal://session`: one change, in revision order. */
export interface TerminalSessionEvent {
  runtimeId: string;
  revision: number;
  session: TerminalSessionInfo;
}

export interface TerminalController {
  available(): boolean;
  /** Windows chain: pwsh → powershell → COMSPEC. Does not open a PTY. */
  resolvedShell(): Promise<ResolvedShellReport>;
  open(opts: { shell: TerminalShell; cwd?: string; cols: number; rows: number }): Promise<string>;
  /** Open a PTY for a *registered installation*, named only by its id — both
   * the executable path and the working directory are resolved server-side
   * (`terminal_open_tool` -> `ToolSupervisor::resolve_launchable`), never
   * supplied by the renderer. This is the interactive-launch counterpart to
   * `launch_tool_detached`; see `terminalTabs.ts`'s `tool` tab spec. */
  openTool(opts: {
    installationId: string;
    args: string[];
    cols: number;
    rows: number;
  }): Promise<string>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
  closeAll(): Promise<TerminalCloseAllReport>;
  onData(listener: (e: TerminalDataEvent) => void): Promise<() => void>;
  /** Fetch what `id` has produced so far — see `TerminalScrollback`. Read-only
   * and safe to call on any session id this surface already knows about. */
  scrollback(id: string): Promise<TerminalScrollback>;
  /** Snapshot of every session Rust holds. Subscribe with `onSession`
   * first, then list, then apply only events newer than the list. */
  listSessions(): Promise<TerminalSessionList>;
  onSession(listener: (e: TerminalSessionEvent) => void): Promise<() => void>;
}

/** What Stop all did (Rust's `CloseAllReport`). `requested` counts the stop
 * requests sent, not confirmed ends; each session in `failed` did not end
 * and is still running, still listed, and can be stopped again. */
export interface TerminalCloseAllReport {
  requested: number;
  failed: { sessionId: string; error: string }[];
}

/** Honest browser stub: no PTY exists outside the native runtime. */
export function createBrowserTerminal(): TerminalController {
  return {
    available: () => false,
    resolvedShell: () => Promise.reject(new Error("terminal_unavailable:browser_mode")),
    open: () => Promise.reject(new Error("terminal_unavailable:browser_mode")),
    openTool: () => Promise.reject(new Error("terminal_unavailable:browser_mode")),
    write: () => Promise.reject(new Error("terminal_unavailable:browser_mode")),
    resize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    closeAll: () => Promise.resolve({ requested: 0, failed: [] }),
    onData: () => Promise.resolve(() => {}),
    // No PTY, no buffer -- an empty snapshot at cursor 0 is the honest
    // answer, not an error: nothing has ever been produced to replay.
    scrollback: () => Promise.resolve({ text: "", cursor: 0 }),
    // No PTY has ever run here: an empty list is the true answer.
    listSessions: () => Promise.resolve({ runtimeId: "browser", revision: 0, sessions: [] }),
    onSession: () => Promise.resolve(() => {}),
  };
}

export const TERMINAL_DATA_EVENT = "terminal://data";
export const TERMINAL_SESSION_EVENT = "terminal://session";
