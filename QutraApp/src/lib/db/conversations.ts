import {
  boundMessages,
  MAX_TITLE_LENGTH,
  titleFromMessages,
  type Conversation,
  type ModelChoice,
  type SavedMessage,
} from "@/domain/conversations";
import { createId } from "@/lib/id";
import type { Database } from "./database";

/* Conversation document operations (data contracts §3). Every one runs in the
   collection's write queue, so a write scheduled before an erase cannot
   commit after it and bring erased text back (TM-006). */

export type NewMessage = Pick<
  SavedMessage,
  "role" | "content" | "answeredBy" | "blocks" | "cloud" | "context" | "personal" | "sources"
>;

export type AppendResult =
  | { ok: true; conversation: Conversation }
  /** The conversation was cleared or deleted after this turn began. */
  | { ok: false; reason: "erased" };

export async function createConversation(
  db: Database,
  {
    workspaceId = null,
    engagementId = null,
    folderId = null,
    model,
    webAccess,
    now = Date.now(),
  }: {
    workspaceId?: string | null;
    engagementId?: string | null;
    /** The folder it starts in (the history panel's "new in this folder"). */
    folderId?: string | null;
    model?: ModelChoice;
    /** Start with the "İnternet" switch on. */
    webAccess?: boolean;
    now?: number;
  } = {},
): Promise<Conversation> {
  return db.collection("conversations").putDurable({
    id: createId("conv"),
    title: "",
    workspaceId,
    engagementId,
    origin: "chat",
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    eraseRevision: 0,
    messages: [],
    ...(folderId ? { folderId } : {}),
    ...(model ? { model } : {}),
    ...(webAccess ? { webAccess: true as const } : {}),
  });
}

/**
 * Append one turn's messages. `expectedEraseRevision` is the revision the
 * caller read when the turn began; it is compared when the write reaches
 * storage, and a mismatch or a missing conversation writes nothing.
 */
export async function appendTurn(
  db: Database,
  {
    conversationId,
    expectedEraseRevision,
    requestId,
    messages,
    now = Date.now(),
  }: {
    conversationId: string;
    expectedEraseRevision: number;
    requestId: string;
    messages: readonly NewMessage[];
    now?: number;
  },
): Promise<AppendResult> {
  const saved = await db
    .collection("conversations")
    .updateDurable(conversationId, (existing) => {
      if (existing.eraseRevision !== expectedEraseRevision) return undefined;
      const added: SavedMessage[] = messages.map((m) => ({
        id: createId("msg"),
        role: m.role,
        content: m.content,
        createdAt: now,
        requestId,
        ...(m.answeredBy ? { answeredBy: m.answeredBy } : {}),
        ...(m.blocks ? { blocks: m.blocks } : {}),
        ...(m.cloud ? { cloud: m.cloud } : {}),
        ...(m.context ? { context: m.context } : {}),
        ...(m.personal ? { personal: m.personal } : {}),
        ...(m.sources?.length ? { sources: m.sources } : {}),
      }));
      const all = boundMessages([...existing.messages, ...added]);
      return {
        ...existing,
        title: existing.title || titleFromMessages(all),
        messages: all,
        updatedAt: now,
      };
    });
  return saved ? { ok: true, conversation: saved } : { ok: false, reason: "erased" };
}

/**
 * Mark a turn's question as sent to the cloud, keeping the text
 * that went out when masking changed it. Later turns send it exactly so,
 * whatever the masking does by then. A question already marked, or one
 * erased meanwhile, is left as it is.
 */
export async function markSent(
  db: Database,
  {
    conversationId,
    requestId,
    sentText,
  }: { conversationId: string; requestId: string; sentText?: string },
): Promise<void> {
  await db.collection("conversations").updateDurable(conversationId, (existing) => {
    let changed = false;
    const messages = existing.messages.map((m) => {
      if (m.role !== "user" || m.requestId !== requestId || m.cloudSent) return m;
      changed = true;
      return {
        ...m,
        cloudSent: true,
        ...(sentText !== undefined && sentText !== m.content ? { cloudContent: sentText } : {}),
      };
    });
    return changed ? { ...existing, messages } : undefined;
  });
}

/** Erase one conversation's title and messages; its links stay. Resolves
    once the erase is on disk, with the emptied document (undefined when
    there was nothing left to erase); rejects, erasing nothing, when the
    write fails. */
export async function clearConversation(
  db: Database,
  conversationId: string,
  now = Date.now(),
): Promise<Conversation | undefined> {
  return db.collection("conversations").updateDurable(conversationId, (existing) => ({
    ...existing,
    title: "",
    messages: [],
    eraseRevision: existing.eraseRevision + 1,
    updatedAt: now,
  }));
}

/** Settings' "clear history": every conversation, titles included. */
export async function clearAllConversations(db: Database): Promise<void> {
  await db.collection("conversations").clearDurable();
}

/** Select a conversation. The chat shows the most recently opened one
    (`latestConversation`), so opening is how the rail and Resume switch it.
    A turn under way stays with the conversation it began in. */
export async function openConversation(
  db: Database,
  conversationId: string,
  now = Date.now(),
): Promise<void> {
  await db
    .collection("conversations")
    .updateDurable(conversationId, (existing) => ({ ...existing, lastOpenedAt: now }));
}

/* ---------- The history panel (2026-10-10) ----------
   Filing, pinning, renaming and archiving change what the history shows,
   never the transcript, so none of them raises the erase revision or
   touches `updatedAt`, which orders the history by the last message. */

type Change = (existing: Conversation) => Conversation | undefined;

function update(db: Database, id: string, change: Change) {
  return db.collection("conversations").updateDurable(id, change);
}

/** A title the user chose. An empty one hands it back to the first
    question, as a conversation that was never named. */
export function renameConversation(db: Database, id: string, title: string) {
  const next = title.trim().slice(0, MAX_TITLE_LENGTH);
  return update(db, id, (c) => {
    const title = next || titleFromMessages(c.messages);
    return title === c.title ? undefined : { ...c, title };
  });
}

export function setPinned(db: Database, id: string, pinned: boolean, now = Date.now()) {
  return update(db, id, (c) => {
    if (pinned === (c.pinnedAt !== undefined)) return undefined;
    const { pinnedAt: _unpinned, ...rest } = c;
    return pinned ? { ...rest, pinnedAt: now } : rest;
  });
}

/** File a conversation in a folder, or take it out of one (null). */
export function moveToFolder(db: Database, id: string, folderId: string | null) {
  return update(db, id, (c) => {
    if ((c.folderId ?? null) === folderId) return undefined;
    const { folderId: _old, ...rest } = c;
    return folderId ? { ...rest, folderId } : rest;
  });
}

/** Archived conversations leave the history and stay in the archive, where
    they can be opened, brought back or deleted. A pin does not survive. */
export function setArchived(db: Database, id: string, archived: boolean, now = Date.now()) {
  return update(db, id, (c) => {
    if (archived === (c.archivedAt !== undefined)) return undefined;
    const { archivedAt: _was, pinnedAt: _pin, ...rest } = c;
    return archived ? { ...rest, archivedAt: now } : rest;
  });
}

/** Data controls' "archive all": every conversation still in the history. */
export async function archiveAllConversations(db: Database, now = Date.now()): Promise<number> {
  const open = db.collection("conversations").getAll().filter((c) => c.archivedAt === undefined);
  await Promise.all(open.map((c) => setArchived(db, c.id, true, now)));
  return open.length;
}

/** The model this conversation's next turns use; null goes back to the
    default. */
export function setConversationModel(db: Database, id: string, model: ModelChoice | null) {
  return update(db, id, (c) => {
    const { model: _old, ...rest } = c;
    return model ? { ...rest, model } : rest;
  });
}

/** The "İnternet" switch of this conversation. Off removes the field, so a
    conversation that never used it is the same as one that turned it off. */
export function setConversationWebAccess(db: Database, id: string, on: boolean) {
  return update(db, id, (c) => {
    if (on === (c.webAccess === true)) return undefined;
    const { webAccess: _was, ...rest } = c;
    return on ? { ...rest, webAccess: true as const } : rest;
  });
}

/** Delete one conversation for good, after the user confirmed it. A turn
    still being written to it is refused where it commits (`appendTurn`). */
export function deleteConversation(db: Database, id: string): Promise<boolean> {
  return db.collection("conversations").removeDurable(id);
}
