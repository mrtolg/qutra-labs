import { useEffect, useRef } from "react";
import { KeepAliveSurfaces } from "@/app/KeepAliveSurfaces";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { getBridge } from "@/lib/bridge";
import { getDb, usePreferences } from "@/lib/db/database";
import { useLabRuntime } from "@/state/labRuntime";
import { closeManagedTerminals } from "@/features/terminal/managedTerminals";
import { connectTerminalSessionFacts } from "@/features/terminal/terminalSessionFacts";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import { ContextPanel } from "@/app/context/ContextPanel";
import { useSurfaceCovered } from "@/app/context/panelState";
import { ConsentSyncAlert } from "./ConsentSyncAlert";
import { revokeNativeConsent, useConsentSync } from "./consentSync";
import "./workbench.css";

/**
 * The workbench below the top bar and its sub-tab row: Surface │ Context
 * panel, the last on demand. The side rail is gone (one navigation bar).
 * Routed pages render into the main surface via KeepAliveSurfaces, which
 * keeps Terminal and Jarvis mounted after first visit so a route change does
 * not end a live PTY or an in-flight assistant turn.
 */
export function Workbench() {
  const prefs = usePreferences();
  const ensureSubscribed = useLabRuntime((s) => s.ensureSubscribed);
  const revoke = useLabRuntime((s) => s.revoke);
  // Keyboard focus must not reach controls hidden behind the overlay panel
  // (WCAG 2.4.11 Focus Not Obscured).
  const covered = useSurfaceCovered();
  const coldStartDone = useRef(false);
  const syncAttempt = useConsentSync((s) => s.attempt);

  // Cold start once per session: context panel closed, so the first paint is
  // the surface — not leftover chrome. Its segment and width are kept.
  useEffect(() => {
    if (coldStartDone.current) return;
    coldStartDone.current = true;
    getDb().prefs.set({ contextPanelOpen: false });
  }, []);

  // One live copy of Rust's terminal session facts for every surface that
  // shows them. Read-only: it never starts or stops a process.
  useEffect(() => {
    const terminal = getBridge().terminal;
    if (!terminal.available()) return;
    // Aborting stops it at once, even mid-list: a connector
    // from an earlier mount can never publish over this one.
    const connection = new AbortController();
    connectTerminalSessionFacts(terminal, { signal: connection.signal }).catch((err) =>
      console.warn("terminal session facts unavailable:", err),
    );
    return () => connection.abort();
  }, []);

  // The preference mirrors native consent. It does not grant. Boot awaits
  // initDb before this tree mounts, so a default-false preference here is a
  // loaded preference, not an empty store.
  useEffect(() => {
    let cancelled = false;
    const preferenceOn = prefs.privateToolsEnabled;
    void (async () => {
      const supervisor = getBridge().toolSupervisor;
      if (!supervisor.available()) return;
      let native = false;
      try {
        native = await supervisor.consentGranted();
      } catch {
        if (!cancelled) useConsentSync.getState().fail("read");
        return;
      }
      if (cancelled) return;
      if (preferenceOn && !native) {
        getDb().prefs.set({ privateToolsEnabled: false });
      }
      if (!preferenceOn && native) {
        // A failed revoke mirrors native into the preference and shows the
        // error. If native still reads granted, the preference turned on and
        // this effect runs again with it.
        await revokeNativeConsent();
        if (getDb().prefs.get().privateToolsEnabled) return;
        native = false;
      }
      if (cancelled) return;
      if (native && preferenceOn) {
        ensureSubscribed();
        useTerminalTabs.getState().allowReseed();
      } else {
        revoke();
        // First-visit hole: the assistant can open a PTY and record an
        // attached tab before Terminal has ever mounted. Revoke cannot
        // depend on that view to close it.
        void closeManagedTerminals();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefs.privateToolsEnabled, syncAttempt, ensureSubscribed, revoke]);

  return (
    /* Every shell region carries its own boundary. Previously only <Outlet/>
       was wrapped, so a throw in the rail or the context panel unmounted the whole tree and left a blank window with no way back.
       Now a broken region collapses to a small retry while the rest of the
       workbench — including navigation out of the problem — keeps working. */
    <div className="workbench">
      <div className="wb-main-col" inert={covered}>
        <main className="main" id="main" tabIndex={-1}>
          <ConsentSyncAlert />
          <KeepAliveSurfaces />
        </main>
      </div>
      <ErrorBoundary variant="panel">
        <ContextPanel />
      </ErrorBoundary>
    </div>
  );
}
