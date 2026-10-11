import { useEffect, useRef } from "react";
import { getBridge } from "@/lib/bridge";
import { useT } from "@/lib/i18n";
import { launchFailureMessage } from "@/lib/launch/launchFailureMessage";
import { useTerminalSession } from "./useTerminalSession";
import { useTerminalTabs, type TerminalTabSpec } from "./terminalTabs";

/**
 * One tab's live xterm surface. Owns its own session end-to-end: attaches on
 * mount, disposes (and so closes the PTY) on unmount. Stays mounted but
 * hidden when its tab isn't active, so switching tabs never tears down the
 * shell underneath — only removing the tab does that. The Terminal page
 * itself is kept alive across route changes, so leaving /terminal
 * is not an unmount and does not close the PTY.
 *
 * This applies uniformly to `attached` tabs too (a session the assistant's
 * `terminal_run` opened, wired up after the fact — see `TerminalTabSpec`).
 * Once the UI attaches to it, the tab owns it exactly like a `shell`/`tool`
 * tab owns the session it opened itself: closing the tab ends the PTY. The
 * alternative — leaving an assistant-opened session un-closable from the UI
 * — would trade one bug (invisible, unkillable until app exit) for another
 * (visible, but still unkillable except by "kill all"), and would mean this
 * component's close behavior depends on how a session came to exist, which
 * is exactly the kind of exception a user has to learn and a reviewer has
 * to re-verify. One rule for every tab kind is the fix.
 */
export function TerminalTab({
  tabId,
  spec,
  active,
  title,
}: {
  tabId: string;
  spec: TerminalTabSpec;
  active: boolean;
  title: string;
}) {
  const controller = getBridge().terminal;
  const { t } = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { attach, dispose, status, error, sessionId } = useTerminalSession(controller, spec);
  const bindSession = useTerminalTabs((s) => s.bindSession);

  useEffect(() => {
    const el = hostRef.current;
    if (el) void attach(el);
    return () => {
      void dispose();
    };
  }, [attach, dispose]);

  useEffect(() => {
    if (sessionId) bindSession(tabId, sessionId);
  }, [tabId, sessionId, bindSession]);

  // `error` is a raw string from `useTerminalSession`, but the two tab kinds
  // populate it from entirely different failure spaces and need different
  // treatment:
  //  - `tool` tabs go through `openTool` -> `terminal_open_tool`, which
  //    resolves through the same `ToolSupervisor::resolve_launchable` gate
  //    as the gui launch route and so can fail with the same stable Rust
  //    refusal codes (`tool_identity_changed`, `tool_disabled`, ...) or a
  //    dynamic `spawn:<os error>`. These get the shared, translated
  //    `launchFailureMessage` mapping so the user never sees a raw Rust
  //    identifier, and any "tool library" advice is accurate.
  //  - `shell` tabs go through `open` -> `terminal_open`, a raw PTY spawn
  //    with no installation, no tool identity, and nothing to look up in the
  //    tool library. Running that through `launchFailureMessage` (keyed only
  //    on `title`) would give actively wrong advice -- e.g. telling the user
  //    to "check pwsh's identity in the tool library" when pwsh isn't a
  //    registered tool at all. Shell tabs surface the raw PTY diagnostic
  //    (`openpty:<os error>`, `spawn:<os error>`) instead: it's the only
  //    honest, actionable thing to show for an unpredictable OS-level spawn
  //    failure, and there's no stable code to translate.
  return (
    <div className="terminal-tab-surface" style={{ display: active ? "flex" : "none" }}>
      {status === "error" && (
        <p className="callout callout--warning">
          {tabErrorMessage(spec, error, title, t)}
        </p>
      )}
      <div ref={hostRef} className="terminal-surface" data-testid="terminal-surface" />
    </div>
  );
}

function tabErrorMessage(
  spec: TerminalTabSpec,
  error: string | undefined,
  title: string,
  t: ReturnType<typeof useT>["t"],
): string {
  if (error === "session_gone") return t("terminal.sessionGone");
  if (error === "scrollback_failed") return t("terminal.scrollbackFailed");
  switch (spec.kind) {
    case "tool":
      return launchFailureMessage(t, error, title);
    case "shell":
      return error ?? "";
    case "attached":
      return error ?? t("terminal.sessionGone");
    default: {
      const _never: never = spec;
      return _never;
    }
  }
}
