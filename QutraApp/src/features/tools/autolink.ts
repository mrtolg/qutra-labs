import type { Database } from "@/lib/db/database";
import type { NativeToolInstallation, NativeToolSupervisor } from "@/lib/bridge/types";
import { launcherTiles, registerCategoryFor, type LauncherTile } from "@/domain/tools/launcherGrid";
import { profileFor } from "@/features/lab/useLocateTool";
import { setInstallationBinding } from "@/features/lab/installationBindings";

/* Finding the toolbox's programs on this computer and linking them.

   Rust looks in the usual places (read only) and hands back each program it
   found: either the installation it already holds for that file, or a held
   candidate that registers by token, through the same call and the same
   hash check as a file the user picked. This module only decides what to do
   with the answer, and one rule rules it: a link that already works is never
   touched. */

export interface AutolinkSummary {
  /** Programs registered now and linked (names, in the order found). */
  registered: string[];
  /** Programs that were registered already and are linked now. */
  linked: string[];
  /** Finds that could not be registered. */
  failed: number;
}

export interface AutolinkLabels {
  /** The name of the setting made for a newly registered program. */
  profileName: (name: string) => string;
  targetArgName: string;
}

/** Tiles that already have a link to a file that is still there, whoever made
    it. They are not looked for, and nothing found later replaces them. */
function hasWorkingLink(tile: LauncherTile): boolean {
  return (
    tile.status.kind === "ready" ||
    tile.status.kind === "changed" ||
    tile.status.kind === "disabled"
  );
}

export async function autolinkDetected({
  supervisor,
  db,
  installations,
  labels,
}: {
  supervisor: Pick<NativeToolSupervisor, "detectInstallations" | "register">;
  db: Database;
  installations: readonly NativeToolInstallation[];
  labels: AutolinkLabels;
}): Promise<AutolinkSummary> {
  const bindings = () => db.collection("installationBindings").getAll();
  const before = launcherTiles(bindings(), installations);
  const skip = before.filter(hasWorkingLink).map((tile) => tile.catalogId);
  const detected = await supervisor.detectInstallations(skip);

  const summary: AutolinkSummary = { registered: [], linked: [], failed: 0 };
  const present = new Set(installations.filter((i) => !i.fileMissing).map((i) => i.id));
  for (const found of detected) {
    // Decided against the store as it is now, not as it was when the scan
    // started: the user may have linked this program in the meantime.
    const current = bindings();
    const tile = before.find((candidate) => candidate.catalogId === found.catalogId);
    if (!tile) continue;
    if (current.some((b) => b.catalogId === found.catalogId && present.has(b.installationId))) {
      continue;
    }
    if (found.registeredId) {
      // The user's own choice of what a registration is stays theirs.
      if (current.some((b) => b.installationId === found.registeredId)) continue;
      setInstallationBinding(db, found.registeredId, found.catalogId, "detected");
      present.add(found.registeredId);
      summary.linked.push(tile.name);
      continue;
    }
    if (!found.located) continue;
    try {
      const saved = await supervisor.register({
        candidateToken: found.located.token,
        displayName: tile.name,
        category: registerCategoryFor(tile),
        riskTier: "low",
        docUrl: tile.downloadUrl,
        tags: [],
        confirmed: true,
      });
      setInstallationBinding(db, saved.id, found.catalogId, "detected");
      db.collection("toolProfiles").put(
        profileFor(saved, undefined, {
          name: labels.profileName(saved.displayName),
          target: labels.targetArgName,
        }),
      );
      present.add(saved.id);
      summary.registered.push(tile.name);
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
