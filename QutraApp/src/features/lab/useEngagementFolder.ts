import { useEffect, useState } from "react";
import type { Engagement } from "@/domain/lab";
import { getDb } from "@/lib/db/database";
import { engagementFolders, type FolderInfo } from "@/lib/engagementFolders";
import { now } from "@/lib/time";
import { useUi } from "@/state/ui";

/**
 * The investigation's folder as Rust has it, and the "Create folder" flow
 * that the header and "Targets and files" share. `info` is undefined while
 * it is read and null when the investigation has no folder. A folder made
 * here is written to the record, so every reader of the folder reads again.
 */
export function useEngagementFolder(engagement: Engagement) {
  const toast = useUi((s) => s.toast);
  const native = engagementFolders.available();
  const [info, setInfo] = useState<FolderInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    engagementFolders.get(engagement.id).then(
      (found) => !cancelled && setInfo(found),
      () => !cancelled && setInfo(null),
    );
    return () => {
      cancelled = true;
    };
  }, [native, engagement.id, engagement.folderPath]);

  const create = async () => {
    setBusy(true);
    try {
      const made = await engagementFolders.create(engagement.id, engagement.title, null);
      // Only the fields this owns, on the row as it is now: a copy taken
      // before the await would put back whatever changed meanwhile (a cloud
      // allowance revoked, for one).
      getDb()
        .collection("engagements")
        .patch(engagement.id, { folderPath: made.path, updatedAt: now() });
      setInfo(made);
    } catch {
      toast({ kind: "danger", messageKey: "lab.folder.createFailed" });
    } finally {
      setBusy(false);
    }
  };

  return { native, info, busy, create };
}
