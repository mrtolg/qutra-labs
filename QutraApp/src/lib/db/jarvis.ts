import {
  MAX_FOLDER_NAME_LENGTH,
  MAX_MEMORY_LENGTH,
  type ConversationFolder,
  type JarvisMemory,
} from "@/domain/conversations";
import { createId } from "@/lib/id";
import type { Database } from "./database";

/* Jarvis's folders and memory (2026-10-10). Each write goes through
   its collection's queue like the conversations' own. */

const folderName = (name: string) => name.trim().slice(0, MAX_FOLDER_NAME_LENGTH);

/** A new folder; a blank name makes none. */
export async function createFolder(
  db: Database,
  name: string,
  now = Date.now(),
): Promise<ConversationFolder | undefined> {
  const clean = folderName(name);
  if (!clean) return undefined;
  return db.collection("conversationFolders").putDurable({
    id: createId("folder"),
    name: clean,
    createdAt: now,
    updatedAt: now,
  });
}

export function renameFolder(db: Database, id: string, name: string, now = Date.now()) {
  const clean = folderName(name);
  return db
    .collection("conversationFolders")
    .updateDurable(id, (f) => (!clean || clean === f.name ? undefined : { ...f, name: clean, updatedAt: now }));
}

/** An archived folder leaves the history with its conversations, which keep
    their own state: brought back, the folder shows them as they were. */
export function setFolderArchived(db: Database, id: string, archived: boolean, now = Date.now()) {
  return db.collection("conversationFolders").updateDurable(id, (f) => {
    if (archived === (f.archivedAt !== undefined)) return undefined;
    const { archivedAt: _was, ...rest } = f;
    return archived ? { ...rest, archivedAt: now, updatedAt: now } : { ...rest, updatedAt: now };
  });
}

/** Delete an archived folder after the user confirmed it. Its conversations
    are not deleted: they come back to the history, out of any folder. */
export async function deleteFolder(db: Database, id: string): Promise<void> {
  const filed = db.collection("conversations").getAll().filter((c) => c.folderId === id);
  await Promise.all(
    filed.map((c) =>
      db.collection("conversations").updateDurable(c.id, (existing) => {
        const { folderId: _gone, ...rest } = existing;
        return rest;
      }),
    ),
  );
  await db.collection("conversationFolders").removeDurable(id);
}

const memoryText = (text: string) => text.trim().slice(0, MAX_MEMORY_LENGTH);

export async function addMemory(
  db: Database,
  text: string,
  now = Date.now(),
): Promise<JarvisMemory | undefined> {
  const clean = memoryText(text);
  if (!clean) return undefined;
  return db.collection("jarvisMemories").putDurable({
    id: createId("mem"),
    text: clean,
    createdAt: now,
    updatedAt: now,
  });
}

export function editMemory(db: Database, id: string, text: string, now = Date.now()) {
  const clean = memoryText(text);
  return db
    .collection("jarvisMemories")
    .updateDurable(id, (m) => (!clean || clean === m.text ? undefined : { ...m, text: clean, updatedAt: now }));
}

export function deleteMemory(db: Database, id: string): Promise<boolean> {
  return db.collection("jarvisMemories").removeDurable(id);
}

export function clearMemories(db: Database): Promise<void> {
  return db.collection("jarvisMemories").clearDurable();
}
