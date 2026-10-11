import { z } from "zod";

/* ============================================================
   Conversation documents (data contracts §3).

   One bounded document per conversation, owned by the document
   store. Streaming state is never stored here: the retained chat
   owner keeps it, keyed by request id. A conversation is local user
   data and grants no scope, project or tool authority.
   ============================================================ */

const ts = z.number().int().nonnegative();

/** The existing transcript bound, kept as the first retention policy. */
export const MAX_CONVERSATION_MESSAGES = 50;
/** A conversation holding Claude answers is append-only: trimming its start
    would break the thinking the service bound to it. It keeps
    this many, the most a cloud turn takes. */
export const MAX_CLOUD_CONVERSATION_MESSAGES = 200;
export const MAX_TITLE_LENGTH = 80;

/** A page an answer drew on, listed under it. Only web addresses are kept:
    an entry that is not one is dropped, and an unreadable list with it,
    rather than setting the message aside. */
export const WebSourceSchema = z.object({
  url: z.string().url().max(2000).regex(/^https?:\/\//i),
  title: z.string().max(200),
});
export type WebSource = z.infer<typeof WebSourceSchema>;

export const SavedMessageSchema = z.object({
  id: z.string().min(1),
  /* No "system": the context block is derived per turn and never stored,
     so clearing a conversation has nothing extra to miss. */
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  /** Null for history migrated from before timestamps were kept. */
  createdAt: ts.nullable(),
  /** The turn that produced the message; null for migrated history. */
  requestId: z.string().nullable(),
  /** Where an answer's turn was sent (security review). */
  answeredBy: z.object({ endpoint: z.string(), model: z.string() }).optional(),
  /** A Claude answer's content blocks, echoed unchanged on the next turn. */
  blocks: z.array(z.unknown()).optional(),
  /** A question that went to the cloud, masked: later turns send it as
      it went, with `cloudContent` when masking changed it. */
  cloudSent: z.boolean().optional(),
  cloudContent: z.string().optional(),
  /** An investigation's summary that went with this question, after the
      consent card; it goes before the question's text. */
  context: z.string().optional(),
  /** Jarvis's memory and the user's instructions, carried by the first
      question of a conversation that goes to the cloud; masked with it and
      counted in its sent line. Goes before the summary and the question. */
  personal: z.string().optional(),
  /** The instructions of the skill picked for this question; they go with
      it, after Jarvis's memory and before the question. */
  skill: z.string().optional(),
  /** The pages a web-enabled answer drew on, cited ones first. */
  sources: z
    .array(z.unknown())
    .transform((items) =>
      items.flatMap((item) => {
        const page = WebSourceSchema.safeParse(item);
        return page.success ? [page.data] : [];
      }).slice(0, 20),
    )
    .optional()
    .catch(undefined),
  /** A cloud answer's facts: where it went, who answered, what it cost. */
  cloud: z
    .object({
      endpoint: z.string(),
      /** The connection: `anthropic` or an OpenAI-compatible preset. */
      provider: z.string().optional(),
      /** How many secrets were masked in what went out. */
      masked: z.number().int().nonnegative().default(0),
      servedBy: z.string(),
      fallbackFrom: z.string().nullable().default(null),
      sentBytes: z.number().int().nonnegative(),
      stop: z.string(),
      refusalCategory: z.string().nullable().default(null),
      inputTokens: z.number().int().nonnegative().default(0),
      outputTokens: z.number().int().nonnegative().default(0),
      costUsd: z.number().nonnegative().nullable().default(null),
    })
    .optional(),
});
export type SavedMessage = z.infer<typeof SavedMessageSchema>;

/** Where Jarvis's answers come from: a model on this computer, or a cloud
    connection with its model. */
export const ModelChoiceSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local"), model: z.string().min(1) }),
  z.object({ provider: z.literal("anthropic"), model: z.string().min(1) }),
  z.object({
    provider: z.literal("openai_compat"),
    preset: z.enum(["openai", "gemini", "openrouter", "groq", "custom"]),
    model: z.string().min(1),
  }),
]);
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

export const ConversationSchema = z.object({
  id: z.string().min(1),
  /** Empty means untitled; the reader supplies localized wording. */
  title: z.string(),
  /* Explicit links only. Never inferred from names or from whichever
     project happens to be selected when a turn is sent. */
  workspaceId: z.string().nullable(),
  engagementId: z.string().nullable(),
  /** "legacyHistory" marks the single transcript kept before conversations were saved. */
  origin: z.enum(["chat", "legacyHistory"]).default("chat"),
  createdAt: ts,
  updatedAt: ts,
  lastOpenedAt: ts,
  /* Raised by every erase. A write that was scheduled before the erase
     carries the old value and is refused when it reaches storage. */
  eraseRevision: z.number().int().nonnegative(),
  messages: z.array(SavedMessageSchema),
  /* The history panel. All optional, and an unreadable
     value is dropped rather than setting the conversation aside: documents
     from before them stay as they are. */
  /** The folder it is filed in; absent or null for none. */
  folderId: z.string().nullable().optional().catch(undefined),
  /** When it was pinned to the top of the history. */
  pinnedAt: ts.optional().catch(undefined),
  /** When it was archived: out of the history, kept in the archive. */
  archivedAt: ts.optional().catch(undefined),
  /** The model chosen for this conversation; absent means the default. */
  model: ModelChoiceSchema.optional().catch(undefined),
  /** The "İnternet" switch: on only when present and true; absent is off. */
  webAccess: z.literal(true).optional().catch(undefined),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const MAX_FOLDER_NAME_LENGTH = 60;

/** A folder of conversations in the history panel. */
export const ConversationFolderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(MAX_FOLDER_NAME_LENGTH),
  createdAt: ts,
  updatedAt: ts,
  /** Archived with the conversations in it. */
  archivedAt: ts.optional().catch(undefined),
});
export type ConversationFolder = z.infer<typeof ConversationFolderSchema>;

export const MAX_MEMORY_LENGTH = 500;

/** One thing Jarvis remembers about the user, written or kept by them. */
export const JarvisMemorySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(MAX_MEMORY_LENGTH),
  createdAt: ts,
  updatedAt: ts,
});
export type JarvisMemory = z.infer<typeof JarvisMemorySchema>;

export type IdFactory = (prefix: string) => string;

/** The length an automatic title aims for. */
export const AUTO_TITLE_LENGTH = 40;

/** Opening words that say how a question is asked, not what about. */
const TITLE_FILLER =
  /^(?:(?:hey|hi|hello|please|so|ok|okay|could you|can you|would you|i want to|i need to|i'd like to|help me|merhaba|selam|lütfen|bana|rica etsem|hallo|bitte|kannst du|könntest du|hola|por favor|puedes|bonjour|salut|s'il vous plaît|peux-tu|ciao|per favore|puoi)[\s,:;!-]+)+/iu;

const TITLE_TAIL = /[\s.,;:!-]+$/u;

/**
 * A short topic for a conversation, made from its first question alone:
 * the first line, without the pleasantries it opens with, cut at a word
 * about `AUTO_TITLE_LENGTH` characters in.
 */
export function titleFromMessages(messages: readonly SavedMessage[]): string {
  const first = messages.find((m) => m.role === "user" && m.content.trim());
  if (!first) return "";
  const line = (first.content.trim().split(/\r?\n/, 1)[0] ?? "")
    .replace(/^[#>*\s-]+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const stripped = line.replace(TITLE_FILLER, "").trim();
  const topic = (stripped || line).replace(TITLE_TAIL, "");
  if (topic.length <= AUTO_TITLE_LENGTH) return topic;
  const cut = topic.slice(0, AUTO_TITLE_LENGTH + 1);
  const space = cut.lastIndexOf(" ");
  // A first word longer than the title is cut where it stands.
  const head =
    space >= AUTO_TITLE_LENGTH / 2 ? cut.slice(0, space) : topic.slice(0, AUTO_TITLE_LENGTH);
  return `${head.replace(TITLE_TAIL, "")}…`;
}

export function boundMessages(messages: readonly SavedMessage[]): SavedMessage[] {
  const cloud = messages.some((m) => m.blocks !== undefined);
  return messages.slice(-(cloud ? MAX_CLOUD_CONVERSATION_MESSAGES : MAX_CONVERSATION_MESSAGES));
}

export function latestConversation(
  conversations: readonly Conversation[],
): Conversation | undefined {
  let latest: Conversation | undefined;
  for (const c of conversations) {
    if (!latest || c.lastOpenedAt > latest.lastOpenedAt) latest = c;
  }
  return latest;
}

const LegacyLineSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  answeredBy: z.unknown().optional(),
});
const LegacyRecipientSchema = z.object({ endpoint: z.string(), model: z.string() });

/**
 * The earlier single transcript (`preferences.localAssistantHistory`) as one
 * conversation, or null when there is nothing to keep — an empty or erased
 * history creates no conversation.
 *
 * Message times are unknown and stay null rather than invented, and the
 * conversation stays unbound: nothing reliable says which project or
 * engagement the old transcript belonged to.
 */
export function conversationFromLegacyHistory(
  history: unknown,
  now: number,
  newId: IdFactory,
): Conversation | null {
  if (!Array.isArray(history)) return null;
  const messages: SavedMessage[] = [];
  for (const item of history) {
    const line = LegacyLineSchema.safeParse(item);
    if (!line.success) continue;
    const recipient = LegacyRecipientSchema.safeParse(line.data.answeredBy);
    messages.push({
      id: newId("msg"),
      role: line.data.role,
      content: line.data.content,
      createdAt: null,
      requestId: null,
      ...(line.data.role === "assistant" && recipient.success
        ? { answeredBy: recipient.data }
        : {}),
    });
  }
  if (messages.length === 0) return null;
  const kept = boundMessages(messages);
  return {
    id: newId("conv"),
    title: titleFromMessages(kept),
    workspaceId: null,
    engagementId: null,
    origin: "legacyHistory",
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    eraseRevision: 0,
    messages: kept,
  };
}
