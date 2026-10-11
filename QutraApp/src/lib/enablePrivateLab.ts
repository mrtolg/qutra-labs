import { getBridge } from "@/lib/bridge";
import { getDb } from "@/lib/db/database";
import { PRIVATE_LAB_GRANT } from "@/domain/privateLab";

export type PrivateLabGrantResult =
  | "granted"
  | "pending"
  | "unavailable"
  | "declined";

/**
 * Native Private Lab consent is the authorization of record. The renderer
 * preference is a mirror written only after native acknowledgement. This does
 * not change L or G, and it does not change what opens the Rust gate: the
 * schema still requires G AND native P as a conjunction, consent is still
 * re-checked at execute, and per-call approval still stands.
 */
export async function grantPrivateLab(): Promise<PrivateLabGrantResult> {
  const supervisor = getBridge().toolSupervisor;
  if (!supervisor.available()) {
    return "unavailable";
  }
  try {
    const acknowledged = await supervisor.requestGrant(getDb().prefs.get().locale);
    if (!acknowledged) {
      return "declined";
    }
    getDb().prefs.set(PRIVATE_LAB_GRANT);
    return "granted";
  } catch {
    return "pending";
  }
}

export async function enablePrivateLab(): Promise<PrivateLabGrantResult> {
  return grantPrivateLab();
}
