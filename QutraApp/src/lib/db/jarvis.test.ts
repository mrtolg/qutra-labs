import { describe, expect, it } from "vitest";
import { ConversationSchema } from "@/domain/conversations";
import { Database } from "./database";
import { MemoryStorageAdapter } from "./storage";
import {
  appendTurn,
  archiveAllConversations,
  createConversation,
  deleteConversation,
  moveToFolder,
  renameConversation,
  setArchived,
  setConversationModel,
  setConversationWebAccess,
  setPinned,
} from "./conversations";
import {
  addMemory,
  clearMemories,
  createFolder,
  deleteFolder,
  deleteMemory,
  editMemory,
  renameFolder,
  setFolderArchived,
} from "./jarvis";

/* The history panel's and Jarvis's settings' writes (2026-10-10). */

const fresh = () => new Database(new MemoryStorageAdapter());

describe("conversation history writes", () => {
  it("renames, and an empty name hands the title back to the first question", async () => {
    const db = fresh();
    const c = await createConversation(db, { now: 1 });
    await appendTurn(db, {
      conversationId: c.id,
      expectedEraseRevision: 0,
      requestId: "r",
      messages: [{ role: "user", content: "naber" }],
      now: 2,
    });
    await renameConversation(db, c.id, "  Keşif notları  ");
    expect(db.collection("conversations").get(c.id)?.title).toBe("Keşif notları");
    await renameConversation(db, c.id, "");
    expect(db.collection("conversations").get(c.id)?.title).toBe("naber");
  });

  it("pins, files, archives and leaves the transcript and its order alone", async () => {
    const db = fresh();
    const c = await createConversation(db, { now: 1 });
    const folder = (await createFolder(db, "ACME", 5))!;
    await setPinned(db, c.id, true, 10);
    await moveToFolder(db, c.id, folder.id);
    let doc = db.collection("conversations").get(c.id)!;
    expect(doc).toMatchObject({ pinnedAt: 10, folderId: folder.id, updatedAt: 1, eraseRevision: 0 });

    await setArchived(db, c.id, true, 20);
    doc = db.collection("conversations").get(c.id)!;
    expect(doc.archivedAt).toBe(20);
    // A pin does not survive the archive.
    expect(doc.pinnedAt).toBeUndefined();

    await setArchived(db, c.id, false);
    await moveToFolder(db, c.id, null);
    doc = db.collection("conversations").get(c.id)!;
    expect(doc.archivedAt).toBeUndefined();
    expect(doc.folderId).toBeUndefined();
  });

  it("archives every conversation still in the history", async () => {
    const db = fresh();
    await createConversation(db, { now: 1 });
    const second = await createConversation(db, { now: 2 });
    await setArchived(db, second.id, true, 3);
    expect(await archiveAllConversations(db, 9)).toBe(1);
    expect(db.collection("conversations").getAll().every((c) => c.archivedAt !== undefined)).toBe(true);
  });

  it("keeps a conversation's own model, and clears it back to the default", async () => {
    const db = fresh();
    const c = await createConversation(db, { now: 1 });
    await setConversationModel(db, c.id, { provider: "local", model: "gemma4:26b" });
    expect(db.collection("conversations").get(c.id)?.model).toEqual({ provider: "local", model: "gemma4:26b" });
    await setConversationModel(db, c.id, null);
    expect(db.collection("conversations").get(c.id)?.model).toBeUndefined();
  });

  it("deletes one conversation", async () => {
    const db = fresh();
    const c = await createConversation(db, { now: 1 });
    await deleteConversation(db, c.id);
    expect(db.collection("conversations").getAll()).toEqual([]);
  });

  it("still reads a conversation stored before the history panel, and drops an unreadable new field", () => {
    const old = {
      id: "conv-old",
      title: "eski",
      workspaceId: null,
      engagementId: null,
      origin: "chat",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
      eraseRevision: 0,
      messages: [],
    };
    expect(ConversationSchema.parse(old)).toEqual(old);
    const odd = ConversationSchema.parse({ ...old, model: { provider: "nope" }, pinnedAt: "x" });
    expect(odd.model).toBeUndefined();
    expect(odd.pinnedAt).toBeUndefined();
  });
});

describe("folders", () => {
  it("creates, renames and archives; a blank name makes nothing", async () => {
    const db = fresh();
    expect(await createFolder(db, "   ")).toBeUndefined();
    const f = (await createFolder(db, "  Müşteri A  ", 1))!;
    expect(f.name).toBe("Müşteri A");
    await renameFolder(db, f.id, "Müşteri B", 2);
    await setFolderArchived(db, f.id, true, 3);
    expect(db.collection("conversationFolders").get(f.id)).toMatchObject({ name: "Müşteri B", archivedAt: 3 });
  });

  it("deleting a folder brings its conversations back, out of any folder", async () => {
    const db = fresh();
    const f = (await createFolder(db, "Old", 1))!;
    const c = await createConversation(db, { folderId: f.id, now: 1 });
    expect(c.folderId).toBe(f.id);
    await deleteFolder(db, f.id);
    expect(db.collection("conversationFolders").getAll()).toEqual([]);
    expect(db.collection("conversations").get(c.id)?.folderId).toBeUndefined();
  });
});

describe("memory", () => {
  it("adds, edits, deletes and clears what Jarvis remembers", async () => {
    const db = fresh();
    expect(await addMemory(db, "  ")).toBeUndefined();
    const m = (await addMemory(db, "Lab ağı 10.10.0.0/24", 1))!;
    await addMemory(db, "Raporlar Türkçe", 2);
    await editMemory(db, m.id, "Lab ağı 10.20.0.0/24", 3);
    expect(db.collection("jarvisMemories").get(m.id)).toMatchObject({ text: "Lab ağı 10.20.0.0/24", updatedAt: 3 });
    await deleteMemory(db, m.id);
    expect(db.collection("jarvisMemories").getAll()).toHaveLength(1);
    await clearMemories(db);
    expect(db.collection("jarvisMemories").getAll()).toEqual([]);
  });
});

describe("the internet switch", () => {
  it("is off until set, kept on the conversation, and gone again when turned off", async () => {
    const db = fresh();
    const c = await createConversation(db, { now: 1 });
    expect(db.collection("conversations").get(c.id)?.webAccess).toBeUndefined();
    await setConversationWebAccess(db, c.id, true);
    expect(db.collection("conversations").get(c.id)?.webAccess).toBe(true);
    await setConversationWebAccess(db, c.id, false);
    expect("webAccess" in db.collection("conversations").get(c.id)!).toBe(false);
    const started = await createConversation(db, { webAccess: true, now: 2 });
    expect(started.webAccess).toBe(true);
  });

  it("keeps the pages an answer drew on, only web addresses of them, and reads older documents as they were", async () => {
    const db = fresh();
    const c = await createConversation(db, { now: 1 });
    await appendTurn(db, {
      conversationId: c.id,
      expectedEraseRevision: 0,
      requestId: "r1",
      messages: [
        {
          role: "assistant",
          content: "Answer",
          sources: [
            { url: "https://a.example/x", title: "A" },
            { url: "javascript:alert(1)", title: "bad" },
            { url: "file:///C:/Windows/win.ini", title: "worse" },
          ],
        },
      ],
    });
    const saved = db.collection("conversations").get(c.id)!;
    expect(saved.messages[0]?.sources).toEqual([{ url: "https://a.example/x", title: "A" }]);
    const parsed = ConversationSchema.parse({
      ...saved,
      webAccess: "yes",
      messages: [{ ...saved.messages[0], sources: "nope" }],
    });
    expect(parsed.webAccess).toBeUndefined();
    expect(parsed.messages[0]?.sources).toBeUndefined();
  });
});
