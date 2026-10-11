import { getDb } from "@/lib/db/database";
import { getBridge } from "@/lib/bridge";
import { createId } from "@/lib/id";
import { now } from "@/lib/time";
import { useUi } from "@/state/ui";
import type { Resource } from "@/domain/types";
import { windowsPathIdentity } from "@/domain/resources";

/* Paths linked to projects, shared by the Files page and the context panel's
   Files segment so both add, open and remove a path the same way. */

export function titleFromPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** Adds a file or folder path; refuses a path that is already listed. */
export function addLinkedPath(
  target: string,
  kind: "file" | "folder",
  workspaceId?: string,
): boolean {
  const path = target.trim();
  if (!path) return false;
  const { toast } = useUi.getState();
  const duplicate = getDb()
    .collection("resources")
    .getAll()
    .some(
      (resource) =>
        (resource.kind === "file" || resource.kind === "folder") &&
        windowsPathIdentity(resource.target) === windowsPathIdentity(path),
    );
  if (duplicate) {
    toast({ kind: "info", messageKey: "files.alreadyListed" });
    return false;
  }
  const record: Resource = {
    id: createId("res"),
    kind,
    title: titleFromPath(path),
    target: path,
    workspaceId: workspaceId || undefined,
    tags: [],
    demo: false,
    createdAt: now(),
  };
  getDb().collection("resources").put(record);
  toast({ kind: "success", messageKey: "files.added" });
  return true;
}

/**
 * Opens a local path with the system's default app. Says so when the browser
 * build cannot, or when the native side refuses or fails; true only on success.
 */
export async function openLocalPath(path: string): Promise<boolean> {
  const { toast } = useUi.getState();
  if (!getBridge().capabilities().openPath.available) {
    toast({ kind: "info", messageKey: "files.openDesktopOnly" });
    return false;
  }
  let ok = false;
  try {
    ok = (await getBridge().openPath(path)).ok;
  } catch {
    ok = false;
  }
  if (!ok) toast({ kind: "danger", messageKey: "files.openFailed" });
  return ok;
}

export async function openLinkedPath(resource: Resource): Promise<void> {
  if (await openLocalPath(resource.target)) {
    getDb().collection("resources").patch(resource.id, { lastOpenedAt: now() });
  }
}

export async function removeLinkedPath(resource: Resource): Promise<void> {
  const { toast } = useUi.getState();
  try {
    const removed = await getDb().collection("resources").removeDurable(resource.id);
    if (!removed) return;
    toast({
      kind: "success",
      messageKey: "files.removed",
      actionKey: "action.undo",
      onAction: () => {
        void getDb().collection("resources").putDurable(resource);
      },
    });
  } catch {
    toast({ kind: "danger", messageKey: "error.dbBody" });
  }
}
