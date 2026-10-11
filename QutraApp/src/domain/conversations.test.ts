import { describe, expect, it } from "vitest";
import {
  ConversationSchema,
  MAX_CLOUD_CONVERSATION_MESSAGES,
  MAX_CONVERSATION_MESSAGES,
  MAX_TITLE_LENGTH,
  boundMessages,
  conversationFromLegacyHistory,
  latestConversation,
  titleFromMessages,
  type Conversation,
  type SavedMessage,
} from "./conversations";

const message = (overrides: Partial<SavedMessage> = {}): SavedMessage => ({
  id: "m-1",
  role: "user",
  content: "hello",
  createdAt: null,
  requestId: null,
  ...overrides,
});

const conversation = (overrides: Partial<Conversation> = {}): Conversation =>
  ConversationSchema.parse({
    id: "conv_mbx1q2r3a1b2c3d4",
    title: "",
    workspaceId: null,
    engagementId: null,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    eraseRevision: 0,
    messages: [],
    ...overrides,
  });

describe("conversation documents", () => {
  it("parses a stored document and defaults its origin to the chat", () => {
    const parsed = conversation();
    expect(parsed.origin).toBe("chat");
    expect(parsed.eraseRevision).toBe(0);
  });

  it("refuses a system message: context is derived per turn, never stored", () => {
    expect(() =>
      conversation({ messages: [message({ role: "system" as never })] }),
    ).toThrow();
  });

  it("refuses a negative erase revision", () => {
    expect(() => conversation({ eraseRevision: -1 })).toThrow();
  });
});

describe("titleFromMessages", () => {
  it("takes the first line of the first question, trimmed", () => {
    expect(
      titleFromMessages([
        message({ role: "assistant", content: "ignored" }),
        message({ content: "  scan the lab subnet\nwith care  " }),
      ]),
    ).toBe("scan the lab subnet");
  });

  it("caps a long question at the title length", () => {
    const title = titleFromMessages([message({ content: "a".repeat(500) })]);
    expect(title).toHaveLength(MAX_TITLE_LENGTH);
  });

  it("is empty when nothing was asked yet", () => {
    expect(titleFromMessages([])).toBe("");
    expect(titleFromMessages([message({ content: "   " })])).toBe("");
  });
});

describe("boundMessages", () => {
  it("keeps the newest messages up to the limit", () => {
    const many = Array.from({ length: MAX_CONVERSATION_MESSAGES + 5 }, (_, i) =>
      message({ id: `m-${i}`, content: `q${i}` }),
    );
    const kept = boundMessages(many);
    expect(kept).toHaveLength(MAX_CONVERSATION_MESSAGES);
    expect(kept[0]?.id).toBe("m-5");
    expect(kept.at(-1)?.id).toBe(`m-${MAX_CONVERSATION_MESSAGES + 4}`);
  });

  it("does not trim a conversation holding Claude answers before the cloud cap", () => {
    const many = Array.from({ length: MAX_CONVERSATION_MESSAGES + 5 }, (_, i) =>
      message({ id: `m-${i}`, content: `q${i}` }),
    );
    many[1] = message({ id: "m-1", role: "assistant", blocks: [{ type: "text", text: "a" }] });
    expect(boundMessages(many)).toHaveLength(MAX_CONVERSATION_MESSAGES + 5);

    const more = Array.from({ length: MAX_CLOUD_CONVERSATION_MESSAGES + 1 }, (_, i) =>
      message({ id: `m-${i}`, blocks: [] }),
    );
    expect(boundMessages(more)).toHaveLength(MAX_CLOUD_CONVERSATION_MESSAGES);
  });

  it("keeps a cloud answer's facts, filling what an older record lacks", () => {
    const parsed = conversation({
      messages: [
        message({
          role: "assistant",
          cloud: {
            endpoint: "api.anthropic.com",
            servedBy: "claude-opus-5-5",
            sentBytes: 10,
            stop: "end_turn",
          } as SavedMessage["cloud"],
        }),
      ],
    });
    expect(parsed.messages[0]?.cloud).toEqual({
      endpoint: "api.anthropic.com",
      masked: 0,
      servedBy: "claude-opus-5-5",
      fallbackFrom: null,
      sentBytes: 10,
      stop: "end_turn",
      refusalCategory: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    });
  });
});

describe("conversationFromLegacyHistory", () => {
  const ids = (() => {
    let n = 0;
    return (prefix: string) => `${prefix}_${++n}`;
  })();

  it("creates nothing from an empty or erased history", () => {
    expect(conversationFromLegacyHistory([], 10, ids)).toBeNull();
    expect(conversationFromLegacyHistory(undefined, 10, ids)).toBeNull();
    expect(conversationFromLegacyHistory("not a list", 10, ids)).toBeNull();
  });

  it("moves the history into one unbound conversation without inventing timestamps", () => {
    const result = conversationFromLegacyHistory(
      [
        { role: "user", content: "what is open on 10.0.0.5?" },
        {
          role: "assistant",
          content: "Port 22.",
          answeredBy: { endpoint: "http://127.0.0.1:11435", model: "qwen2.5:14b" },
        },
      ],
      1_700_000_000_000,
      ids,
    );
    expect(result).not.toBeNull();
    const conv = ConversationSchema.parse(result);
    expect(conv.origin).toBe("legacyHistory");
    expect(conv.workspaceId).toBeNull();
    expect(conv.engagementId).toBeNull();
    expect(conv.eraseRevision).toBe(0);
    expect(conv.title).toBe("what is open on 10.0.0.5?");
    expect(conv.createdAt).toBe(1_700_000_000_000);
    expect(conv.messages.map((m) => [m.role, m.content, m.createdAt, m.requestId])).toEqual([
      ["user", "what is open on 10.0.0.5?", null, null],
      ["assistant", "Port 22.", null, null],
    ]);
    expect(conv.messages[1]?.answeredBy).toEqual({
      endpoint: "http://127.0.0.1:11435",
      model: "qwen2.5:14b",
    });
    expect(new Set(conv.messages.map((m) => m.id)).size).toBe(2);
  });

  it("drops system lines and malformed entries but keeps the rest", () => {
    const conv = conversationFromLegacyHistory(
      [
        { role: "system", content: "context" },
        { role: "user", content: 42 },
        null,
        { role: "user", content: "kept" },
        { role: "assistant", content: "also kept", answeredBy: { endpoint: 1 } },
      ],
      5,
      ids,
    );
    expect(conv?.messages.map((m) => m.content)).toEqual(["kept", "also kept"]);
    // A malformed recipient is dropped, not trusted.
    expect(conv?.messages[1]?.answeredBy).toBeUndefined();
  });

  it("creates nothing when every entry is unusable", () => {
    expect(
      conversationFromLegacyHistory([{ role: "system", content: "x" }], 5, ids),
    ).toBeNull();
  });

  it("keeps only the newest messages of an oversized history", () => {
    const history = Array.from({ length: MAX_CONVERSATION_MESSAGES + 3 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `line ${i}`,
    }));
    const conv = conversationFromLegacyHistory(history, 5, ids);
    expect(conv?.messages).toHaveLength(MAX_CONVERSATION_MESSAGES);
    expect(conv?.messages[0]?.content).toBe("line 3");
  });
});

describe("latestConversation", () => {
  it("returns the most recently opened conversation", () => {
    const a = conversation({ id: "a", lastOpenedAt: 5 });
    const b = conversation({ id: "b", lastOpenedAt: 9 });
    const c = conversation({ id: "c", lastOpenedAt: 7 });
    expect(latestConversation([a, b, c])?.id).toBe("b");
    expect(latestConversation([])).toBeUndefined();
  });
});
