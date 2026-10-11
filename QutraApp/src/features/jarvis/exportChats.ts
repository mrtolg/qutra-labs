import type { Conversation, ConversationFolder } from "@/domain/conversations";
import type { useT } from "@/lib/i18n";

type Translate = ReturnType<typeof useT>["t"];

/* Data controls' export: every conversation, archived
   ones too, as a Markdown file to read or a JSON file to keep. What goes in
   is what the user wrote and what Jarvis answered, never a key. */

const byCreated = (a: Conversation, b: Conversation) => a.createdAt - b.createdAt;

export function chatsAsMarkdown(
  t: Translate,
  locale: string,
  conversations: readonly Conversation[],
  folders: readonly ConversationFolder[],
  now: number,
): string {
  const date = (at: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const lines = [`# ${t("jarvis.data.exportTitle")}`, "", t("jarvis.data.exportedAt", { date: date(now) })];
  for (const c of [...conversations].sort(byCreated)) {
    const title = c.title || t("jarvis.conversation.untitled");
    const facts = [date(c.createdAt)];
    const folder = c.folderId ? folderName.get(c.folderId) : undefined;
    if (folder) facts.push(t("jarvis.data.inFolder", { name: folder }));
    if (c.archivedAt !== undefined) facts.push(t("jarvis.data.archived"));
    lines.push("", "---", "", `## ${title}`, "", `_${facts.join(" · ")}_`);
    for (const m of c.messages) {
      const who = m.role === "user" ? t("localAssistant.you") : t("localAssistant.assistant");
      lines.push("", `**${who}:**`, "", m.content || "…");
    }
  }
  return `${lines.join("\n")}\n`;
}

export function chatsAsJson(
  conversations: readonly Conversation[],
  folders: readonly ConversationFolder[],
  now: number,
): string {
  return JSON.stringify(
    {
      kind: "jarvis-conversations",
      version: 1,
      exportedAt: new Date(now).toISOString(),
      folders,
      conversations: conversations.map((c) => ({
        ...c,
        // Content blocks are the service's own wire format, not the user's.
        messages: c.messages.map(({ blocks: _blocks, ...m }) => m),
      })),
    },
    null,
    2,
  );
}

/** Hands the file to the browser's download, as the app's other exports do. */
export function download(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
