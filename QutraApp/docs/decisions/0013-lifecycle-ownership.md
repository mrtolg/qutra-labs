# ADR 0013 — Lifecycle ownership as it actually shipped

**Status:** accepted · 2026-09-16 · amended 2026-09-16

## Context

Leaving `/terminal` closed the PTY, and leaving the assistant
rejected a pending approval. Both cleanups were deliberate — without them the
broker's single-flight slot stays held until `TURN_TIMEOUT` (50 minutes). The
original design asked for a lifecycle *service* that owned sessions independently of
the route. What shipped in `a7f48e6` was `KeepAliveSurfaces`: after the first
visit, `TerminalPage` and `JarvisPage` stay mounted and are only hidden.

This document describes that model, not the one originally planned. ADR 0012 Decision
1b is the precedent for saying so.

This amendment does not replace KeepAlive with a service. It closes leaks and holes that
KeepAlive left: overlapping attach under StrictMode, a PTY acquired then
orphaned when wiring failed, one error boundary around every retained owner, a
first-visit hole on Private Lab revoke, explicit end actions that did not
actually end the work, and an abort-before-registration race on the assistant
client.

## Decision

**Ownership still lives in the components for work they acquired.** `TerminalTab`
still disposes its PTY on unmount. `LocalAssistantChat` still rejects a pending
approval and aborts the turn on unmount, and when Local assistant is turned off.
Keep-alive changes *when* those components unmount, not *whether* they own the
work they started.

Unmount is not app quit. Unmount is not consent revocation. Those are separate
paths and must not be described as the same event.

`KeepAliveSurfaces` (`src/app/KeepAliveSurfaces.tsx`):

- statically imports `TerminalPage` and `JarvisPage` (lazy loading them hung
  tests; the entry-chunk gzip cost is the price of that);
- mounts each the first time its route is visited;
- hides it with `hidden` when the user navigates elsewhere;
- does **not** mount either on a cold start until that route is opened;
- wraps Terminal, Jarvis, and the `Outlet` in **separate** error boundaries.
  A render error in Files or GitHub must not unmount the retained owners.
  When the Terminal owner genuinely dies, tab records are invalidated and
  native sessions are closed; Try again must not silently relaunch a
  registered tool under an old tab identity.

What it guarantees: navigating from Terminal or Assistant to Home (or anywhere
else in the shell) does not end a live PTY or an in-flight turn.

What it does not: a lifecycle service, a session object that outlives its
component, a heartbeat lease, or work that continues after the owning component
is gone — except where an explicit end action or revoke closes work that the
view never mounted (below).

## Termination contract

Work ends when:

1. The owning component unmounts (tab close, error-boundary death of that
   owner). This is not app quit and it is not consent revocation.
2. Local assistant is turned off (the chat releases the broker slot).
3. Agent tool proposals are turned off (the current agent turn stops). Closing
   a terminal still ends only that terminal; there is no terminal-to-turn
   dependency graph.
4. Clear conversation: cancel the turn first, then wipe history, so a late
   result cannot repopulate it and the broker is not left sitting on an
   approval the UI already removed.
5. Stop all / Private Lab revoke: close managed terminals, including ones
   created before Terminal was ever visited, and do not auto-reseed a shell.
   Revoke cannot depend on mounted children.
6. Orderly shutdown (`pagehide`) and renderer load both call
   `abandonPreviousRendererWork` (cancel turn, `terminal_close_all`, forget
   agent sessions). There is one primitive, not two.
7. The broker's own deadlines (`TURN_TIMEOUT`, per-step timeouts).

Cancellation on those paths is still required. Deleting the unmount cleanups
would reinstate the 50-minute busy lock.

## Attach generation and ownership at acquisition

`useTerminalSession` used a shared resettable `cancelled` flag. StrictMode
runs setup, cleanup, setup: the second `attach()` set the flag back to false,
so the first in-flight attach opened a PTY that the final cleanup did not
close. Attach now captures a per-operation generation. `dispose` increments
it. Nothing writes it back to "not cancelled".

Ownership is recorded when `open` / `openTool` returns, not after xterm
wiring. If attachment or scrollback then fails, the acquired id is closed.
Attached tabs do not acquire; a transport failure there must not kill a PTY
we did not open. Confirmed absence (`unknown_session`) is `session_gone`.
Any other scrollback rejection is `scrollback_failed`.

The assistant client uses the same generation idea: the abort listener is
installed before `listen()` is awaited, and abort during registration does
not call `assistant_start`.

## Generation guard

`labRuntime.revoke()` used to clear `unlisten` and in-memory state while an
in-flight `refresh()` could still `set()` afterwards, and a late `listen()`
could reassign `unlisten`. Result: `subscribed: false` with native data
repopulating and a listener running unclaimed.

Every consent/lifecycle epoch now carries a `generation`. `revoke()` (and test
dispose) increments it first. Every async return, event callback, and delayed
refresh checks it. A late `listen()` closes immediately. Late results reach
neither the Zustand store nor the persisted mirror.

## Renderer-load invalidate and orderly shutdown

On renderer load, after the native bridge is registered, the renderer tells
Rust to cancel the active assistant turn (if any) and `terminal_close_all`.
`pagehide` reuses that same command. That is a cheap replacement for a
heartbeat lease: a reload or an orderly quit is a new owner (or no owner).

**Crash-without-reload is uncovered and accepted.** If the webview dies and
never fires `pagehide` or boots again, the turn lives until `TURN_TIMEOUT` and
PTYs live until process exit. A lease would cover that; this command does not.
Job Objects stay out.

The browser/demo path is a no-op. It must not fake a native close.

## Consequences

+ Navigating around the shell no longer kills the user's terminal or turn.
+ Consent withdrawal no longer loses a race to a late refresh, and no longer
  leaves a PTY that was opened before Terminal mounted.
+ A reload or orderly shutdown does not leave the previous webview's turn
  holding the slot.
+ A failed Files/GitHub render does not close retained PTYs. Retrying a
  failed Terminal page does not relaunch a registered tool by itself.

− Ownership is still in components for work they acquired. A future unmount
  of that owner still ends that work. Anyone adding a new live surface must
  keep it mounted the same way, or accept that leaving it ends the work.
− The entry chunk pays for statically importing Terminal and Jarvis. Last
  measured after this amendment (2026-09-16): gzip **167483** / budget
  204800, remaining **37317**.
− Crash-without-reload remains a gap. Closing it needs a lease, which this ADR
  explicitly does not add.
