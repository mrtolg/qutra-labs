import { describe, expect, it } from "vitest";
import type { Conversation, ConversationFolder } from "@/domain/conversations";
import { bucketOf, buildArchive, buildHistory, searchConversations } from "./history";

const DAY = 24 * 60 * 60 * 1000;
// A fixed local noon, so day boundaries do not depend on when the test runs.
const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();

function conv(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: id,
    workspaceId: null,
    engagementId: null,
    origin: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    lastOpenedAt: NOW - 1000,
    eraseRevision: 0,
    messages: [{ id: `${id}-m`, role: "user", content: `about ${id}`, createdAt: NOW, requestId: "r" }],
    ...overrides,
  };
}

const folder = (id: string, name: string, overrides: Partial<ConversationFolder> = {}): ConversationFolder => ({
  id,
  name,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("bucketOf", () => {
  it("groups by local day: today, yesterday, the week, the month, then by month", () => {
    expect(bucketOf(NOW - 60_000, NOW)).toEqual({ kind: "today" });
    expect(bucketOf(NOW - DAY, NOW)).toEqual({ kind: "yesterday" });
    expect(bucketOf(NOW - 5 * DAY, NOW)).toEqual({ kind: "week" });
    expect(bucketOf(NOW - 20 * DAY, NOW)).toEqual({ kind: "month" });
    expect(bucketOf(new Date(2026, 5, 3).getTime(), NOW)).toEqual({ kind: "older", month: "2026-06" });
  });
});

describe("buildHistory", () => {
  it("puts pinned first, folders with their conversations, and the rest by day, newest first", () => {
    const history = buildHistory(
      [
        conv("today-old", { updatedAt: NOW - 3_600_000 }),
        conv("today-new", { updatedAt: NOW - 60_000 }),
        conv("yesterday", { updatedAt: NOW - DAY }),
        conv("pinned", { pinnedAt: NOW, updatedAt: NOW - 10 * DAY }),
        conv("filed", { folderId: "f1", updatedAt: NOW - 40 * DAY }),
        conv("pinned-filed", { folderId: "f1", pinnedAt: NOW - 5 }),
      ],
      [folder("f1", "ACME"), folder("f2", "Boş")],
      { activeId: null, now: NOW },
    );
    expect(history.pinned.map((c) => c.id)).toEqual(["pinned", "pinned-filed"]);
    expect(history.folders.map((f) => [f.folder.name, f.conversations.map((c) => c.id)])).toEqual([
      ["ACME", ["pinned-filed", "filed"]],
      ["Boş", []],
    ]);
    expect(history.groups.map((g) => [g.key, g.conversations.map((c) => c.id)])).toEqual([
      ["today", ["today-new", "today-old"]],
      ["yesterday", ["yesterday"]],
    ]);
  });

  it("leaves out archived conversations, those in an archived folder, and empty ones not open", () => {
    const history = buildHistory(
      [
        conv("archived", { archivedAt: NOW }),
        conv("in-archived-folder", { folderId: "old" }),
        conv("empty", { title: "", messages: [] }),
        conv("empty-open", { title: "", messages: [] }),
        conv("lost-folder", { folderId: "gone" }),
      ],
      [folder("old", "Old", { archivedAt: NOW })],
      { activeId: "empty-open", now: NOW },
    );
    expect(history.folders).toEqual([]);
    expect(history.groups.flatMap((g) => g.conversations.map((c) => c.id))).toEqual([
      "empty-open",
      "lost-folder",
    ]);
  });
});

describe("buildArchive", () => {
  it("holds archived folders with what is filed in them and the conversations archived alone", () => {
    const archive = buildArchive(
      [conv("alone", { archivedAt: NOW }), conv("filed", { folderId: "old" }), conv("live")],
      [folder("old", "Old", { archivedAt: NOW }), folder("open", "Open")],
    );
    expect(archive.folders.map((f) => [f.folder.id, f.conversations.map((c) => c.id)])).toEqual([
      ["old", ["filed"]],
    ]);
    expect(archive.conversations.map((c) => c.id)).toEqual(["alone"]);
  });
});

describe("searchConversations", () => {
  it("matches every word in titles and messages, with a snippet when only a message matched", () => {
    const hits = searchConversations(
      [
        conv("a", { title: "Nmap taraması", updatedAt: NOW - 10 }),
        conv("b", {
          title: "Rapor",
          messages: [
            { id: "m", role: "assistant", content: "Bu hostta açık bir nmap portu bulundu.", createdAt: NOW, requestId: "r" },
          ],
        }),
        conv("c", { title: "Başka" }),
      ],
      "NMAP",
      "tr",
    );
    expect(hits.map((h) => h.conversation.id)).toEqual(["b", "a"]);
    expect(hits[0]!.snippet).toContain("nmap portu");
    expect(hits[1]!.snippet).toBeUndefined();
  });

  it("folds Turkish dotted and dotless i by the locale", () => {
    const hits = searchConversations([conv("x", { title: "İnceleme notları" })], "inceleme", "tr");
    expect(hits).toHaveLength(1);
  });

  it("finds nothing for an empty query", () => {
    expect(searchConversations([conv("a")], "   ", "en")).toEqual([]);
  });
});
