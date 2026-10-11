import { describe, expect, it } from "vitest";
import { Database } from "./database";
import { MemoryStorageAdapter } from "./storage";
import {
  appendTurn,
  clearAllConversations,
  clearConversation,
  createConversation,
  markSent,
  openConversation,
} from "./conversations";
import { MAX_CONVERSATION_MESSAGES } from "@/domain/conversations";

const freshDb = () => new Database(new MemoryStorageAdapter());

/** Parks durable commits on a slow disk until `release()`. */
function heldDisk() {
  const storage = new MemoryStorageAdapter();
  let holding = false;
  let releaseCommit: (() => void) | null = null;
  let onParked: (() => void) | null = null;
  storage.flush = () => {
    if (!holding) return Promise.resolve();
    return new Promise<void>((resolve) => {
      releaseCommit = resolve;
      onParked?.();
    });
  };
  return {
    db: new Database(storage),
    storage,
    hold: () => {
      holding = true;
    },
    /** Resolves once a commit is waiting on the disk. */
    parked: () =>
      new Promise<void>((resolve) => {
        if (releaseCommit) resolve();
        else onParked = resolve;
      }),
    release: () => {
      holding = false;
      releaseCommit?.();
      releaseCommit = null;
    },
  };
}

const stored = (storage: MemoryStorageAdapter) =>
  JSON.parse(storage.read("conversations") ?? "[]") as { id: string; messages: unknown[] }[];

const question = { role: "user" as const, content: "what listens on 10.0.0.5?" };
const answer = { role: "assistant" as const, content: "Port 22." };

describe("createConversation", () => {
  it("stores an empty, unbound conversation opened now", async () => {
    const db = freshDb();
    const conv = await createConversation(db, { now: 100 });
    expect(conv).toMatchObject({
      title: "",
      workspaceId: null,
      engagementId: null,
      origin: "chat",
      createdAt: 100,
      updatedAt: 100,
      lastOpenedAt: 100,
      eraseRevision: 0,
      messages: [],
    });
    expect(conv.id).toMatch(/^conv_/);
    expect(db.collection("conversations").getAll()).toEqual([conv]);
  });

  it("keeps an explicit engagement link and nothing inferred", async () => {
    const db = freshDb();
    const conv = await createConversation(db, { engagementId: "eng_1", now: 1 });
    expect(conv.engagementId).toBe("eng_1");
    expect(conv.workspaceId).toBeNull();
  });
});

describe("appendTurn", () => {
  it("appends the turn with its request id and time, and titles the conversation", async () => {
    const db = freshDb();
    const conv = await createConversation(db, { now: 1 });
    const result = await appendTurn(db, {
      conversationId: conv.id,
      expectedEraseRevision: 0,
      requestId: "req-1",
      messages: [question, answer],
      now: 50,
    });
    expect(result.ok).toBe(true);
    const saved = db.collection("conversations").get(conv.id);
    expect(saved?.title).toBe("what listens on 10.0.0.5?");
    expect(saved?.updatedAt).toBe(50);
    expect(saved?.messages.map((m) => [m.role, m.content, m.requestId, m.createdAt])).toEqual([
      ["user", "what listens on 10.0.0.5?", "req-1", 50],
      ["assistant", "Port 22.", "req-1", 50],
    ]);
  });

  it("keeps a question as it went to the cloud, once", async () => {
    const db = freshDb();
    const conv = await createConversation(db, { now: 1 });
    const turn = (requestId: string, content: string) =>
      appendTurn(db, {
        conversationId: conv.id,
        expectedEraseRevision: 0,
        requestId,
        messages: [{ role: "user", content }],
      });
    await turn("req-1", "my password=hunter22");
    await turn("req-2", "plain question");

    await markSent(db, { conversationId: conv.id, requestId: "req-1", sentText: "my password=[masked password]" });
    await markSent(db, { conversationId: conv.id, requestId: "req-2", sentText: "plain question" });
    // A second mark changes nothing: the first text that went out stays.
    await markSent(db, { conversationId: conv.id, requestId: "req-1", sentText: "other" });

    const [first, second] = db.collection("conversations").get(conv.id)!.messages;
    expect(first).toMatchObject({
      content: "my password=hunter22",
      cloudSent: true,
      cloudContent: "my password=[masked password]",
    });
    expect(second).toMatchObject({ content: "plain question", cloudSent: true });
    expect(second).not.toHaveProperty("cloudContent");
  });

  it("keeps an answer's recipient", async () => {
    const db = freshDb();
    const conv = await createConversation(db, { now: 1 });
    const answeredBy = { endpoint: "http://127.0.0.1:11435", model: "qwen2.5:14b" };
    await appendTurn(db, {
      conversationId: conv.id,
      expectedEraseRevision: 0,
      requestId: "req-1",
      messages: [{ ...answer, answeredBy }],
    });
    expect(db.collection("conversations").get(conv.id)?.messages[0]?.answeredBy).toEqual(
      answeredBy,
    );
  });

  it("keeps only the newest messages", async () => {
    const db = freshDb();
    const conv = await createConversation(db, { now: 1 });
    for (let i = 0; i < MAX_CONVERSATION_MESSAGES + 2; i += 1) {
      await appendTurn(db, {
        conversationId: conv.id,
        expectedEraseRevision: 0,
        requestId: `req-${i}`,
        messages: [{ role: "user", content: `q${i}` }],
      });
    }
    const messages = db.collection("conversations").get(conv.id)?.messages ?? [];
    expect(messages).toHaveLength(MAX_CONVERSATION_MESSAGES);
    expect(messages[0]?.content).toBe("q2");
  });

  it("refuses a turn scheduled before the conversation was cleared", async () => {
    const db = freshDb();
    const conv = await createConversation(db, { now: 1 });
    await clearConversation(db, conv.id);

    const late = await appendTurn(db, {
      conversationId: conv.id,
      expectedEraseRevision: 0,
      requestId: "req-late",
      messages: [question, answer],
    });

    expect(late).toEqual({ ok: false, reason: "erased" });
    expect(db.collection("conversations").get(conv.id)?.messages).toEqual([]);
  });

  it("never recreates a conversation erased by clear-all", async () => {
    const db = freshDb();
    const conv = await createConversation(db, { now: 1 });
    await clearAllConversations(db);

    const late = await appendTurn(db, {
      conversationId: conv.id,
      expectedEraseRevision: 0,
      requestId: "req-late",
      messages: [question],
    });

    expect(late).toEqual({ ok: false, reason: "erased" });
    expect(db.collection("conversations").getAll()).toEqual([]);
  });
});

/* TM-006: the revision is checked where the write commits, not where it
   was scheduled. A slow disk must not let an earlier write land on top of a
   later erase, in storage or in memory. */
describe("erase against writes still on their way to disk", () => {
  it("clear-all queued behind a held append leaves nothing behind", async () => {
    const { db, storage, hold, parked, release } = heldDisk();
    const conv = await createConversation(db, { now: 1 });

    hold();
    const append = appendTurn(db, {
      conversationId: conv.id,
      expectedEraseRevision: 0,
      requestId: "req-1",
      messages: [question, answer],
    });
    await parked();
    const erase = clearAllConversations(db);
    release();
    await Promise.all([append, erase]);

    expect(db.collection("conversations").getAll()).toEqual([]);
    expect(stored(storage)).toEqual([]);
  });

  it("clearing one conversation behind a held append empties it and raises its revision", async () => {
    const { db, storage, hold, parked, release } = heldDisk();
    const conv = await createConversation(db, { now: 1 });

    hold();
    const append = appendTurn(db, {
      conversationId: conv.id,
      expectedEraseRevision: 0,
      requestId: "req-1",
      messages: [question, answer],
    });
    await parked();
    const erase = clearConversation(db, conv.id);
    release();
    await Promise.all([append, erase]);

    const after = db.collection("conversations").get(conv.id);
    expect(after?.messages).toEqual([]);
    expect(after?.title).toBe("");
    expect(after?.eraseRevision).toBe(1);
    expect(stored(storage)[0]?.messages).toEqual([]);
  });

  it("an append scheduled behind a held clear is refused when it reaches storage", async () => {
    const { db, storage, hold, parked, release } = heldDisk();
    const conv = await createConversation(db, { now: 1 });

    hold();
    const erase = clearConversation(db, conv.id);
    await parked();
    const append = appendTurn(db, {
      conversationId: conv.id,
      expectedEraseRevision: 0,
      requestId: "req-1",
      messages: [question],
    });
    release();
    const [, result] = await Promise.all([erase, append]);

    expect(result).toEqual({ ok: false, reason: "erased" });
    expect(stored(storage)[0]?.messages).toEqual([]);
  });
});

describe("clearConversation", () => {
  it("erases title and messages but keeps the conversation and its links", async () => {
    const db = freshDb();
    const conv = await createConversation(db, { engagementId: "eng_1", now: 1 });
    await appendTurn(db, {
      conversationId: conv.id,
      expectedEraseRevision: 0,
      requestId: "req-1",
      messages: [question, answer],
    });

    await clearConversation(db, conv.id, 9);

    expect(db.collection("conversations").get(conv.id)).toMatchObject({
      id: conv.id,
      engagementId: "eng_1",
      title: "",
      messages: [],
      eraseRevision: 1,
      updatedAt: 9,
    });
  });
});

describe("openConversation", () => {
  it("marks the conversation as the one opened last", async () => {
    const db = freshDb();
    const first = await createConversation(db, { now: 1 });
    await createConversation(db, { now: 2 });

    await openConversation(db, first.id, 3);

    expect(db.collection("conversations").get(first.id)?.lastOpenedAt).toBe(3);
  });
});
