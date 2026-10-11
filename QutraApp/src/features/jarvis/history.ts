import type { Conversation, ConversationFolder } from "@/domain/conversations";

/* What the history panel lists, as pure functions of
   the stored documents so the panel only lays them out. */

export type DateBucket =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "week" }
  | { kind: "month" }
  /** Older: the calendar month, as `YYYY-MM`. */
  | { kind: "older"; month: string };

export interface DateGroup {
  key: string;
  bucket: DateBucket;
  conversations: Conversation[];
}

export interface FolderEntry {
  folder: ConversationFolder;
  conversations: Conversation[];
}

export interface History {
  pinned: Conversation[];
  folders: FolderEntry[];
  groups: DateGroup[];
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function bucketOf(at: number, now: number): DateBucket {
  const today = startOfDay(now);
  if (at >= today) return { kind: "today" };
  if (at >= today - DAY) return { kind: "yesterday" };
  if (at >= today - 6 * DAY) return { kind: "week" };
  if (at >= today - 29 * DAY) return { kind: "month" };
  const d = new Date(at);
  return { kind: "older", month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` };
}

const bucketKey = (b: DateBucket) => (b.kind === "older" ? `older:${b.month}` : b.kind);

const newestFirst = (a: Conversation, b: Conversation) => b.updatedAt - a.updatedAt;

/** Out of the history: archived itself, or filed in an archived folder. */
export function isArchived(c: Conversation, folders: ReadonlyMap<string, ConversationFolder>): boolean {
  if (c.archivedAt !== undefined) return true;
  const folder = c.folderId ? folders.get(c.folderId) : undefined;
  return folder?.archivedAt !== undefined;
}

/** A conversation nothing was asked in yet is listed only while it is the
    one open: an empty "New conversation" row elsewhere would be noise. */
function listed(c: Conversation, activeId: string | null): boolean {
  return c.messages.length > 0 || c.title !== "" || c.id === activeId;
}

export function folderMap(folders: readonly ConversationFolder[]) {
  return new Map(folders.map((f) => [f.id, f]));
}

/**
 * The history: pinned conversations first, then the folders with what is
 * filed in each, then the rest by the day of their last message. A pinned
 * conversation shows under Pinned and in its folder, never twice in the
 * dates. A conversation whose folder is gone shows in the dates.
 */
export function buildHistory(
  conversations: readonly Conversation[],
  folders: readonly ConversationFolder[],
  { activeId, now }: { activeId: string | null; now: number },
): History {
  const byId = folderMap(folders);
  const live = conversations.filter((c) => !isArchived(c, byId) && listed(c, activeId));

  const pinned = live
    .filter((c) => c.pinnedAt !== undefined)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));

  const openFolders = folders
    .filter((f) => f.archivedAt === undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
  const filed = new Map<string, Conversation[]>(openFolders.map((f) => [f.id, []]));
  const loose: Conversation[] = [];
  for (const c of live) {
    const list = c.folderId ? filed.get(c.folderId) : undefined;
    if (list) list.push(c);
    else if (c.pinnedAt === undefined) loose.push(c);
  }

  const groups: DateGroup[] = [];
  for (const c of loose.sort(newestFirst)) {
    const bucket = bucketOf(c.updatedAt, now);
    const key = bucketKey(bucket);
    const last = groups.at(-1);
    if (last?.key === key) last.conversations.push(c);
    else groups.push({ key, bucket, conversations: [c] });
  }

  return {
    pinned,
    folders: openFolders.map((folder) => ({
      folder,
      conversations: (filed.get(folder.id) ?? []).sort(newestFirst),
    })),
    groups,
  };
}

/** What the archive holds: archived folders with what is filed in them, and
    the conversations archived on their own. */
export function buildArchive(
  conversations: readonly Conversation[],
  folders: readonly ConversationFolder[],
): { folders: FolderEntry[]; conversations: Conversation[] } {
  const archivedFolders = folders
    .filter((f) => f.archivedAt !== undefined)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  const inArchived = new Set(archivedFolders.map((f) => f.id));
  return {
    folders: archivedFolders.map((folder) => ({
      folder,
      conversations: conversations.filter((c) => c.folderId === folder.id).sort(newestFirst),
    })),
    conversations: conversations
      .filter((c) => c.archivedAt !== undefined && !(c.folderId && inArchived.has(c.folderId)))
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
  };
}

export interface SearchHit {
  conversation: Conversation;
  /** A short piece of the first message that matched, when the title did not. */
  snippet?: string;
}

const SNIPPET_BEFORE = 24;
const SNIPPET_LENGTH = 90;

/** Conversations whose title or messages hold every word of the query,
    newest first. Case and Turkish dotted/dotless i follow the locale. */
export function searchConversations(
  conversations: readonly Conversation[],
  query: string,
  locale: string,
): SearchHit[] {
  const fold = (text: string) => text.toLocaleLowerCase(locale);
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const c of [...conversations].sort(newestFirst)) {
    const title = fold(c.title);
    const texts = c.messages.map((m) => m.content);
    const all = `${title}\n${fold(texts.join("\n"))}`;
    if (!words.every((w) => all.includes(w))) continue;
    if (words.every((w) => title.includes(w))) {
      hits.push({ conversation: c });
      continue;
    }
    const first = words[0]!;
    const message = texts.find((text) => fold(text).includes(first));
    if (!message) {
      hits.push({ conversation: c });
      continue;
    }
    const at = fold(message).indexOf(first);
    const start = Math.max(0, at - SNIPPET_BEFORE);
    const piece = message.slice(start, start + SNIPPET_LENGTH).replace(/\s+/g, " ").trim();
    hits.push({
      conversation: c,
      snippet: `${start > 0 ? "…" : ""}${piece}${start + SNIPPET_LENGTH < message.length ? "…" : ""}`,
    });
  }
  return hits;
}
