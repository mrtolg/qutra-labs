import { invoke } from "@tauri-apps/api/core";
import { getBridge } from "@/lib/bridge";

/** Private Lab consent as Rust holds it: the authorization of record, and
    since when it has been granted (the time its marker was written). */
export interface PrivateLabConsentStatus {
  granted: boolean;
  /** Epoch ms; null when denied or when the time cannot be read. */
  grantedAt: number | null;
}

/** Read the native consent; null in the browser build, which has none. */
export async function readPrivateLabConsent(): Promise<PrivateLabConsentStatus | null> {
  if (!getBridge().toolSupervisor.available()) return null;
  const status = await invoke<{ granted: boolean; grantedAt?: number | null }>(
    "private_tools_consent_status",
  );
  return { granted: status.granted === true, grantedAt: status.grantedAt ?? null };
}
