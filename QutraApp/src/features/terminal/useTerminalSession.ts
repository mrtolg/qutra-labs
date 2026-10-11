import { useCallback, useRef, useState } from "react";
import type { TerminalController } from "@/lib/bridge/terminal";
import type { TerminalTabSpec } from "./terminalTabs";
import { xtermThemeFromDocument } from "@/lib/terminalTheme";

interface XtermLike {
  write(data: string): void;
  onData(handler: (data: string) => void): void;
}

export interface WiredSession {
  id: string;
  dispose: () => Promise<void>;
}

/** Wire an already-opened session id to the xterm surface: replay whatever
 * the session already produced, route incoming bytes in, forward keystrokes
 * out, and give back an idempotent disposer. Pure wiring, unit-testable
 * without a real DOM or PTY.
 *
 * `id`'s PTY may have been producing output since before this
 * function was ever called (the agent's `terminal_run` opens a session
 * immediately; the tab that will render it may not mount until the user
 * later navigates to Terminal). The handover below is what makes that
 * output recoverable without either a gap or a duplicate:
 *
 * 1. Subscribe to live `terminal://data` events *first*, buffering them
 *    (not writing to `xterm` yet) — so nothing emitted from this instant
 *    onward is ever missed, even while the next step's round trip is in
 *    flight.
 * 2. Fetch the `scrollback` snapshot (`{ text, cursor }`).
 * 3. Write `text` to `xterm` — the backlog, oldest-first.
 * 4. Replay only the buffered live events whose `seq` is *greater than*
 *    `cursor`: those are exactly, and only, the bytes that arrived after
 *    the snapshot was taken. An event with `seq <= cursor` is already
 *    *accounted for* by the snapshot and must be dropped, not reapplied.
 *    The server appends to its buffer and reports the same cumulative
 *    counter atomically — see `Scrollback::push` in `terminal/mod.rs` — so
 *    a chunk's `seq` and the snapshot's `cursor` are always cleanly
 *    ordered, never straddling one chunk in half.
 *
 *    Note "accounted for", not "present in `text`": `cursor` counts every
 *    byte the session ever produced, while `text` is capped at
 *    `SCROLLBACK_CAP_BYTES` and trimmed oldest-first. Once a session has
 *    produced more than the cap, the oldest chunks have `seq <= cursor` yet
 *    are no longer in `text` at all — they were dropped server-side and are
 *    unrecoverable here. Dropping them is still the correct action, but for
 *    a different reason than "already shown": replaying them would write
 *    long-since-scrolled-off bytes *after* newer output, corrupting the
 *    order. What the `seq > cursor` filter guarantees is no duplication and
 *    no reordering — not that nothing was lost.
 * 5. From then on, live events are written straight to `xterm` as they
 *    arrive.
 *
 * This runs identically for every `TerminalTabSpec` kind. For `shell`/`tool`
 * tabs it also closes a smaller, previously-undocumented race: the PTY is
 * live from the moment `controller.open`/`openTool` resolves, but this
 * function's listener did not exist until now, so anything printed in
 * between used to be lost. It is not a regression for any tab kind — an
 * already-open tab still sees every live byte exactly as before; it now
 * additionally recovers whatever it would previously have missed. */
export async function wireFromId(
  controller: TerminalController,
  xterm: XtermLike,
  id: string,
): Promise<WiredSession> {
  let capturing = true;
  const pending: { seq: number; data: string }[] = [];
  const off = await controller.onData((e) => {
    if (e.id !== id) return;
    if (capturing) {
      pending.push({ seq: e.seq, data: e.data });
    } else {
      xterm.write(e.data);
    }
  });

  // Confirmed absence (`unknown_session`) is not the same as a transport
  // or read failure. Treating every rejection as "the PTY is gone" made a
  // dropped IPC look like a dead session, and the tab then refused to
  // attach to a process that was still running.
  let snapshot: { text: string; cursor: number };
  try {
    snapshot = await controller.scrollback(id);
  } catch (error) {
    off();
    throw isUnknownSession(error) ? "session_gone" : "scrollback_failed";
  }
  if (snapshot.text) xterm.write(snapshot.text);
  for (const item of pending) {
    if (item.seq > snapshot.cursor) xterm.write(item.data);
  }
  capturing = false;
  // Drop the handover buffer: the closure outlives this function and would
  // otherwise pin every replayed chunk for the listener's lifetime.
  pending.length = 0;

  xterm.onData((data) => {
    void controller.write(id, data);
  });
  return {
    id,
    dispose: async () => {
      off();
      // Idempotent close: never let a "session already gone" rejection
      // escape a dispose path (e.g. effect cleanup runs `void dispose()`).
      try {
        await controller.close?.(id);
      } catch {
        /* already gone, or the bridge was torn down */
      }
    },
  };
}

/** Minimal surface `attach` needs from a live `@xterm/xterm` Terminal instance. */
export interface XtermInstance extends XtermLike {
  readonly cols: number;
  readonly rows: number;
  loadAddon(addon: unknown): void;
  open(el: HTMLElement): void;
  dispose(): void;
  options: { theme?: Record<string, string | undefined> };
}

/** Minimal surface `attach` needs from a live `@xterm/addon-fit` FitAddon instance. */
export interface FitAddonInstance {
  fit(): void;
}

export interface TerminalCtor {
  new (options: Record<string, unknown>): XtermInstance;
}

export interface FitAddonCtor {
  new (): FitAddonInstance;
}

/** Injectable loaders for the (slow, code-split) xterm modules — real dynamic
 * imports by default, swappable for fakes in tests. */
export interface TerminalLoaders {
  loadTerminal: () => Promise<{ Terminal: TerminalCtor }>;
  loadFit: () => Promise<{ FitAddon: FitAddonCtor }>;
  loadCss: () => Promise<unknown>;
}

const defaultLoaders: TerminalLoaders = {
  loadTerminal: () => import("@xterm/xterm") as unknown as Promise<{ Terminal: TerminalCtor }>,
  loadFit: () => import("@xterm/addon-fit") as unknown as Promise<{ FitAddon: FitAddonCtor }>,
  loadCss: () => import("@xterm/xterm/css/xterm.css"),
};

/** Rust reports `unknown_session` when the id is not in the map. Older
 * tests and some wrapped IPC errors say "no such session". Anything else
 * is a transport or read failure, not confirmed absence. */
export function isUnknownSession(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return text.includes("unknown_session") || text.includes("no such session");
}

export function useTerminalSession(
  controller: TerminalController,
  spec: TerminalTabSpec,
  loaders: TerminalLoaders = defaultLoaders,
) {
  const [status, setStatus] = useState<"idle" | "open" | "error">("idle");
  const [error, setError] = useState<string>();
  // The session this surface is wired to, for whoever shows its facts.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionRef = useRef<WiredSession | null>(null);
  const attachingRef = useRef(false);
  // Per-operation generation. `dispose` increments it; `attach` captures
  // the value at start and never writes it back to "not cancelled". A
  // shared resettable boolean was wrong under StrictMode: the second
  // attach() set `cancelled = false` and the first attach, still in
  // flight, opened a PTY that nobody closed.
  const generationRef = useRef(0);

  const attach = useCallback(
    async (el: HTMLElement) => {
      if (sessionRef.current || attachingRef.current) return;
      attachingRef.current = true;
      const mine = generationRef.current;
      const live = () => generationRef.current === mine;
      // PTY this operation opened (shell/tool). Attached tabs do not
      // acquire; they only wire. Record at acquisition, not after wiring,
      // so a failed scrollback still has something to close.
      let acquiredId: string | null = null;
      let xterm: XtermInstance | undefined;
      let stopTheme: (() => void) | undefined;
      try {
        const { Terminal } = await loaders.loadTerminal();
        if (!live()) return;
        const { FitAddon } = await loaders.loadFit();
        if (!live()) return;
        await loaders.loadCss();
        if (!live()) return;

        const theme = xtermThemeFromDocument();
        const surface = new Terminal({
          convertEol: false,
          cursorBlink: true,
          fontFamily: "Cascadia Mono, Consolas, monospace",
          ...(theme ? { theme } : {}),
        });
        xterm = surface;
        const fit = new FitAddon();
        surface.loadAddon(fit);
        surface.open(el);
        fit.fit();
        const applyTheme = () => {
          const next = xtermThemeFromDocument();
          if (next) surface.options.theme = { ...next };
        };
        const themeObserver = new MutationObserver(applyTheme);
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme", "data-mode"],
        });
        stopTheme = () => themeObserver.disconnect();
        // `attached` names a session the broker already opened (see
        // `TerminalTabSpec`'s doc comment) -- there is nothing to open here,
        // so this branch skips `controller.open`/`openTool` entirely and
        // goes straight to `wireFromId` below with the given id. Output the
        // PTY already produced before this attach runs *is* replayed, up to
        // `SCROLLBACK_CAP_BYTES` (`terminal/mod.rs`) worth of it --
        // see `wireFromId`'s doc comment for the replay handover itself.
        // What is not guaranteed: output beyond that per-session cap, which
        // is dropped oldest-first server-side and cannot be recovered here
        // or anywhere else. Do not present this tab's scrollback as an
        // unbounded transcript.
        let id: string;
        switch (spec.kind) {
          case "shell":
            acquiredId = await controller.open({
              shell: spec.shell,
              cols: surface.cols,
              rows: surface.rows,
            });
            id = acquiredId;
            break;
          case "tool":
            acquiredId = await controller.openTool({
              installationId: spec.installationId,
              args: spec.args,
              cols: surface.cols,
              rows: surface.rows,
            });
            id = acquiredId;
            break;
          case "attached":
            id = spec.sessionId;
            break;
          default: {
            const _never: never = spec;
            return _never;
          }
        }
        if (!live()) {
          stopTheme();
          if (acquiredId) {
            try {
              await controller.close?.(acquiredId);
            } catch {
              /* already gone */
            }
            acquiredId = null;
          }
          surface.dispose();
          return;
        }
        const session = await wireFromId(controller, surface, id);
        if (!live()) {
          stopTheme();
          await session.dispose();
          surface.dispose();
          acquiredId = null;
          return;
        }
        const onResize = () => {
          fit.fit();
          void controller.resize(session.id, surface.cols, surface.rows);
        };
        window.addEventListener("resize", onResize);
        sessionRef.current = {
          id: session.id,
          dispose: async () => {
            stopTheme?.();
            window.removeEventListener("resize", onResize);
            await session.dispose();
            surface.dispose();
          },
        };
        acquiredId = null;
        setSessionId(session.id);
        setStatus("open");
      } catch (e) {
        stopTheme?.();
        if (acquiredId) {
          try {
            await controller.close?.(acquiredId);
          } catch {
            /* already gone */
          }
          acquiredId = null;
        }
        xterm?.dispose();
        if (live()) {
          setError(String(e));
          setStatus("error");
        }
      } finally {
        if (live()) attachingRef.current = false;
      }
    },
    [controller, spec, loaders],
  );

  const dispose = useCallback(async () => {
    const mine = ++generationRef.current;
    attachingRef.current = false;
    const session = sessionRef.current;
    sessionRef.current = null;
    await session?.dispose();
    if (
      generationRef.current === mine &&
      !attachingRef.current &&
      !sessionRef.current
    ) {
      setSessionId(null);
      setStatus("idle");
    }
  }, []);

  return { attach, dispose, status, error, sessionId };
}
