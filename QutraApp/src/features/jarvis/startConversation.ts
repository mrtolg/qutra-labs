import { latestConversation } from "@/domain/conversations";
import type { Database } from "@/lib/db/database";
import { createConversation, moveToFolder, openConversation } from "@/lib/db/conversations";

/**
 * New conversation, from the top bar's row or a folder's menu. One empty
 * conversation is enough to start from: the one shown is reused while
 * nothing was asked in it, unless it is about an investigation or a
 * project, since a new one is about nothing yet and a question in it must
 * never take an investigation's summary along. Started from a folder, it is
 * filed there.
 */
export async function startConversation(
  db: Database,
  { folderId = null }: { folderId?: string | null } = {},
): Promise<void> {
  const shown = latestConversation(
    db.collection("conversations").getAll().filter((c) => c.archivedAt === undefined),
  );
  const reusable =
    shown &&
    shown.messages.length === 0 &&
    !shown.engagementId &&
    !shown.workspaceId;
  if (reusable) {
    if ((shown.folderId ?? null) !== folderId) await moveToFolder(db, shown.id, folderId);
    await openConversation(db, shown.id);
    return;
  }
  await createConversation(db, { folderId });
}
