import { create } from "zustand";
import { getBridge } from "@/lib/bridge";
import { getDb } from "@/lib/db/database";

/**
 * A failed sync between the Private Lab preference and native consent. Only
 * the desktop app can fail this way; browser mode has no native consent, so
 * nothing here is ever set there.
 */
export type ConsentSyncFailure = "read" | "revoke";

interface ConsentSyncState {
  failure: ConsentSyncFailure | null;
  /** Bumped by Retry after a failed read, so Workbench reads again. */
  attempt: number;
  fail(failure: ConsentSyncFailure): void;
  clear(): void;
}

export const useConsentSync = create<ConsentSyncState>((set) => ({
  failure: null,
  attempt: 0,
  fail: (failure) => set({ failure }),
  clear: () => set({ failure: null }),
}));

/**
 * Revoke native consent, then mirror what native reports. Rust denies in
 * memory before it persists, so after a failed revoke native usually reads
 * denied; if it still reads granted the preference says so, and the failure
 * stays on screen until Retry succeeds.
 */
export async function revokeNativeConsent(): Promise<void> {
  const supervisor = getBridge().toolSupervisor;
  if (!supervisor.available()) {
    getDb().prefs.set({ privateToolsEnabled: false });
    return;
  }
  try {
    await supervisor.revoke();
  } catch {
    let native = false;
    try {
      native = await supervisor.consentGranted();
    } catch {
      // Unreadable: show it as off. The native gate still decides.
    }
    getDb().prefs.set({ privateToolsEnabled: native });
    useConsentSync.getState().fail("revoke");
    return;
  }
  useConsentSync.getState().clear();
  getDb().prefs.set({ privateToolsEnabled: false });
}

export function retryConsentSync(): void {
  const { failure } = useConsentSync.getState();
  if (failure === "revoke") {
    void revokeNativeConsent();
    return;
  }
  useConsentSync.setState((s) => ({ failure: null, attempt: s.attempt + 1 }));
}
