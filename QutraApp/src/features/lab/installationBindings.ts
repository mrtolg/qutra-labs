import { canHoldInstallation, launcherItem } from "@/domain/tools/launcher";
import type { Database } from "@/lib/db/database";
import { now } from "@/lib/time";

/** Record, change or clear the user's answer to "which catalog item is this
    installation?". One binding per installation, keyed by its id. An empty
    or unbindable catalog id clears it rather than storing something the
    launcher would refuse. */
export function setInstallationBinding(
  db: Database,
  installationId: string,
  catalogId: string,
  /** "detected" marks a link the app made for a program it found; leave it
      out for a link the user chose. */
  source?: "detected",
): void {
  const bindings = db.collection("installationBindings");
  if (!catalogId || !canHoldInstallation(launcherItem(catalogId))) {
    bindings.remove(installationId);
    return;
  }
  bindings.put({
    id: installationId,
    catalogId,
    installationId,
    confirmedAt: now(),
    ...(source ? { source } : {}),
  });
}
