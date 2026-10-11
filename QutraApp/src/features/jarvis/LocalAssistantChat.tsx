import { Fragment, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Loader2, Square } from "lucide-react";
import { type AssistantMessage } from "@/domain/localAssistant";
import { loadInvestigationSummary } from "@/features/lab/investigationSummary";
import { consentMatches, grantCloudConsent, sameConnection } from "@/lib/cloudConsent";
import { AssistantReadiness } from "./AssistantReadiness";
import { LocalEngineActivity } from "@/features/localEngine/LocalEngineActivity";
import { ConsentCard, SentContext, type ConsentCardState } from "./ConsentParts";
import {
  contextSystemMessage,
  packAssistantContext,
} from "@/domain/assistantContext";
import { AssistantModeChips, AssistantSetup, RestoreToolProposals } from "./AssistantSetup";
import { getDb, useCollection, usePreferences } from "@/lib/db/database";
import {
  appendTurn,
  clearConversation,
  createConversation,
  markSent,
  openConversation,
  setConversationModel,
  type NewMessage,
} from "@/lib/db/conversations";
import {
  latestConversation,
  MAX_CLOUD_CONVERSATION_MESSAGES,
  type SavedMessage,
  type WebSource,
} from "@/domain/conversations";
import {
  aiConnections,
  isAiError,
  targetKey,
  type AiTarget,
  type KeyStatus,
} from "@/lib/aiConnections";
import {
  cloudHistory,
  CloudTurnRefused,
  historyHoldsSummary,
  streamCloudChat,
  type CloudBound,
} from "@/lib/cloudAssistant";
import { createId } from "@/lib/id";
import { useUi } from "@/state/ui";
import {
  AssistantBlockedError,
  type AssistantHealth,
  AssistantTimeoutError,
  type AssistantStreamEvent,
  type TurnBinding,
  localAssistant,
} from "@/lib/localAssistant/client";
import { assistantErrorMessage } from "@/lib/localAssistant/assistantErrorMessage";
import { useT } from "@/lib/i18n";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import { ApprovalCard, type PendingApproval } from "./ApprovalCard";
import {
  AssistantHeader,
  Composer,
  JarvisMark,
  JarvisTurn,
  StarterPrompts,
  TurnRecipient,
  UserTurn,
  earlierRecipient,
} from "./AssistantParts";
import {
  CloudAnswerMeta,
  CloudBadge,
  CloudSetupNotice,
  CloudTurnStatus,
  CutOffNotice,
  cloudErrorText,
  connectionName,
  providerId,
  refusalText,
  type CloudNote,
} from "./CloudParts";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ContextDisclosure } from "./ContextDisclosure";
import { resolveModel, targetOf } from "./jarvisModel";
import { useJarvisUi } from "./jarvisUi";
import { ModelChip } from "./ModelChip";
import { personalBlock } from "./personal";
import { SkillPicker } from "./SkillPicker";
import { skillById, skillInstruction, type SkillId } from "./skills";
import { WebChip, WebSources, WebToggle, webAvailable } from "./WebAccess";
import "./assistant.css";

/** A resolved tool call, rendered as a static line once its `tool_result`
    arrives -- the approval card for that `callId` is gone by then. */
interface ToolResultEntry {
  callId: string;
  summary: string;
}

/* Streaming chat against the local lab (ADR 0010 / §3.14).

   The transcript is a conversation document and is never sent anywhere
   except to the loopback endpoint the user configured -- or, once the user
   chose one in Settings, the cloud connection whose key Rust holds, which
   gets the conversation, never the project context; an investigation's
   summary goes only after its consent card. Documents are
   bounded (`MAX_CONVERSATION_MESSAGES`) and written on turn boundaries
   rather than per token, so streaming does not hammer the write queue. */

/** The conversation this chat writes to, and the erase revision it read. */
interface ActiveConversation {
  id: string;
  eraseRevision: number;
}

/** What preparing a question about an investigation found: go (with the
    summary when it goes now), or hold, with the card, the revoked
    investigation or the error to show. */
type Prepared =
  | { go: true; context?: string }
  | { go: false; card?: ConsentCardState; revoked?: string; error?: string };

function toAssistantMessage(m: SavedMessage): AssistantMessage {
  return {
    role: m.role,
    content: m.content,
    ...(m.answeredBy ? { answeredBy: m.answeredBy } : {}),
    ...(m.blocks ? { blocks: m.blocks } : {}),
    ...(m.cloud ? { cloud: m.cloud } : {}),
    ...(m.cloudSent ? { cloudSent: true } : {}),
    ...(m.cloudContent !== undefined ? { cloudContent: m.cloudContent } : {}),
    ...(m.context ? { context: m.context } : {}),
    ...(m.sources?.length ? { sources: m.sources } : {}),
  };
}

/** Turn failures that mean the local engine or its model is not usable
    (ADR 0016). After one of these, the readiness panel checks again so its
    step (download the engine, prepare the model, pick another) comes back. */
const READINESS_CODES = new Set([
  "offline",
  "timeout_health",
  "model_missing",
  "model_cloud_backed",
  "invalid_model",
  "engine_missing",
  "engine_corrupt",
  "model_needs_prepare",
  "model_unsupported",
  "model_unreadable",
  "engine_start_failed",
  "engine_load_failed",
  "engine_out_of_memory",
  "engine_model_metadata",
  "engine_load_timeout",
]);

/** The host of the address a key was saved for. */
const hostOf = (baseUrl: string | null | undefined): string => {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
};

export function LocalAssistantChat() {
  const { t, locale } = useT();
  const prefs = usePreferences();
  const db = getDb();

  // The chat shows the most recently opened conversation: `openConversation`
  // is how the history and Resume select one. The document store is
  // synchronous, so it is already here on the first render.
  const conversations = useCollection("conversations");
  const shown = latestConversation(conversations);

  /* The model the shown conversation's next turn uses: its own choice, else
     the default -- the local model, Claude, or the
     OpenAI-compatible service chosen in Settings. The browser
     build has no cloud connections, so it stays with the local model there. */
  const resolved = resolveModel(shown?.model, prefs);
  const cloud = resolved.provider !== "local" && aiConnections.available();
  const localModel = resolved.provider === "local" ? resolved.model : prefs.ollamaModel;
  const cloudProvider = cloud ? resolved.provider : null;
  const cloudPreset = resolved.preset;
  const cloudTarget = useMemo<AiTarget | null>(
    () =>
      cloudProvider === null ? null : targetOf({ provider: cloudProvider, preset: cloudPreset }),
    [cloudProvider, cloudPreset],
  );
  const cloudModel = cloudTarget ? resolved.model : "";
  const cloudName = cloudTarget ? connectionName(t, cloudTarget) : "";
  /* The "İnternet" switch counts only where it can work: with a local model,
     or with Claude. Kept on the conversation, off unless set. */
  const webCan = webAvailable(cloudTarget);
  const webOn = shown?.webAccess === true && webCan;
  const [webSearching, setWebSearching] = useState(false);
  /** Whether the connection has a key, and for which connection Rust said. */
  const [cloudKey, setCloudKey] = useState<{ target: string; status: KeyStatus } | null>(null);
  const keyStatus =
    cloudTarget && cloudKey?.target === targetKey(cloudTarget) ? cloudKey.status : null;
  /** A turn that cannot go out yet: the notices above the composer say why. */
  const cloudBlocked = cloud && (!cloudModel || keyStatus?.present === false);
  const settingsOpen = useUi((state) => state.settingsSection !== null);
  // Jarvis's own settings hold the same key cards.
  const jarvisSettingsOpen = useJarvisUi((state) => state.settings !== null);

  const workspaces = useCollection("workspaces");
  const resources = useCollection("resources");
  const activeWorkspaceId = useUi((state) => state.activeWorkspaceId);
  // A `terminal_run` that opened its own session (no
  // `sessionId` given) is otherwise invisible -- nothing in the renderer
  // ever wires up that PTY's `terminal://data`, so every byte the command
  // produced was silently dropped and the session lived until app exit.
  // Opening an `attached` tab for it the moment its `tool_result` arrives
  // makes it a real, inspectable terminal tab, honoring what ADR 0012
  // Decision 1 already claims about `terminal_run` being visible.
  const openAttachedTab = useTerminalTabs((state) => state.openAttachedTab);

  const engagements = useCollection("engagements");
  const memories = useCollection("jarvisMemories");
  /** Jarvis's memory and the user's instructions. */
  const personal = personalBlock(t, prefs, memories);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /** The project the context is built from: the chosen one, else the one
      worked on last. */
  const project = useMemo(
    () =>
      workspaces.find((w) => w.id === activeWorkspaceId) ??
      [...workspaces]
        .filter((w) => w.status !== "archived")
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0],
    [workspaces, activeWorkspaceId],
  );
  const projectId = project?.id ?? "";

  /* Built from records the app already has. Nothing is read from disk, so no
     filesystem capability is involved and no path the user did not already
     register can appear here. */
  const context = useMemo(() => {
    if (!prefs.assistantContextEnabled) {
      return { text: "", summary: [], truncated: false };
    }
    return packAssistantContext({
      project: project
        ? {
            name: project.name,
            purpose: project.purpose,
            localPath: project.localPath,
          }
        : undefined,
      resources: project
        ? resources
            .filter((r) => r.workspaceId === project.id)
            .map((r) => ({ title: r.title, target: r.target, kind: r.kind }))
        : [],
    });
  }, [prefs.assistantContextEnabled, project, resources]);

  const [active, setActive] = useState<ActiveConversation | null>(() =>
    shown ? { id: shown.id, eraseRevision: shown.eraseRevision } : null,
  );
  const activeRef = useRef(active);
  const adopt = (next: ActiveConversation | null) => {
    activeRef.current = next;
    setActive(next);
  };
  const [messages, setMessages] = useState<AssistantMessage[]>(
    () => shown?.messages.map(toAssistantMessage) ?? [],
  );
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  /** One-shot text for the polite status region (see the live-region note). */
  const [announcement, setAnnouncement] = useState("");
  /** The skill picked for the next question; it goes with that one only. */
  const [skillId, setSkillId] = useState<SkillId | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(
    null,
  );
  const [toolResults, setToolResults] = useState<ToolResultEntry[]>([]);
  /** A first question about an investigation, waiting on the consent card;
      and the investigation of a conversation that may not go on
      in the cloud, with the way to a new one. */
  const [consentCard, setConsentCard] = useState<ConsentCardState | null>(null);
  const [revokedLink, setRevokedLink] = useState<string | null>(null);
  /** A question being prepared (the allowance read, the summary built). The
      ref is set before anything is awaited, so a second Enter meanwhile is
      not a second turn; the state shows it. */
  const preparingRef = useRef(false);
  const [preparing, setPreparing] = useState(false);
  /** A clear is an erase on disk, not on screen: until it commits the
      transcript still exists, and a failed one says so. */
  const [erase, setErase] = useState<"idle" | "pending" | "failed">("idle");
  /** The clear button was pressed; nothing is erased until it is confirmed. */
  const [confirmClear, setConfirmClear] = useState(false);
  /** A message of the shown conversation that storage did not keep. */
  const [notSaved, setNotSaved] = useState(false);
  /** The conversation the turn in flight began in, and the erase revision it
      read. It stays there when another conversation is opened. */
  const turnRef = useRef<ActiveConversation | null>(null);
  const [turnConversationId, setTurnConversationId] = useState<string | null>(null);
  const [askPrivateLab, setAskPrivateLab] = useState(false);
  /** Where the turn in flight is being sent, once Rust has bound it. */
  const [turnBinding, setTurnBinding] = useState<TurnBinding | null>(null);
  /** A cloud turn in flight: where Rust sent it, and what it waits on. */
  const [cloudBound, setCloudBound] = useState<CloudBound | null>(null);
  const [cloudNote, setCloudNote] = useState<CloudNote | null>(null);
  /* Readiness stays reachable in the enabled view, not only in the setup
     screens, so the engine's next step and the retry are there exactly when
     they are needed. */
  const [health, setHealth] = useState<AssistantHealth | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const healthProbeRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  // Mirrors `pendingApproval` so owner teardown — not navigation, not
  // by itself app quit — closes over the latest card, not the one from mount.
  const pendingApprovalRef = useRef<PendingApproval | null>(null);
  const turnEpochRef = useRef(0);
  /** Which way the turn in flight went. Switching the local model or its tools off
      ends a local turn, not a cloud one. */
  const turnKindRef = useRef<"local" | "cloud" | null>(null);
  const agentToolsWasOn = useRef(prefs.assistantAgentToolsEnabled);

  useEffect(() => {
    pendingApprovalRef.current = pendingApproval;
  }, [pendingApproval]);

  const releaseBrokerSlot = (updateUi: boolean) => {
    const current = pendingApprovalRef.current;
    if (current && current.decision === "awaiting") {
      pendingApprovalRef.current = { ...current, decision: "rejected" };
      void localAssistant.approveTool(current.requestId, current.callId, false);
    }
    abortRef.current?.abort();
    abortRef.current = null;
    if (updateUi) {
      setPendingApproval(null);
      setStreaming(false);
    }
  };

  // The chat (and so this cleanup) now outlives the /jarvis route. Unmount
  // is owner teardown (error-boundary death, tree replacement), not "the
  // user opened Home" and not by itself app quit or consent revocation.
  // Without this the broker's single-flight slot stays held until TURN_TIMEOUT.
  useEffect(() => {
    return () => {
      releaseBrokerSlot(false);
    };
  }, []);

  useEffect(() => {
    if (!prefs.localAssistantEnabled && turnKindRef.current !== "cloud") {
      releaseBrokerSlot(true);
    }
  }, [prefs.localAssistantEnabled]);

  useEffect(() => {
    const on = prefs.assistantAgentToolsEnabled;
    if (agentToolsWasOn.current && !on && turnKindRef.current !== "cloud") {
      releaseBrokerSlot(true);
    }
    agentToolsWasOn.current = on;
  }, [prefs.assistantAgentToolsEnabled]);

  /* Asked again each time Settings closes, where a key is saved or removed.
     Rust says only whether there is one and its last four characters. */
  useEffect(() => {
    if (!cloudTarget || settingsOpen || jarvisSettingsOpen) return;
    let live = true;
    aiConnections.keyStatus(cloudTarget).then(
      (status) => {
        if (live) setCloudKey({ target: targetKey(cloudTarget), status });
      },
      (caught: unknown) => {
        console.error("cloud key status not read", caught);
      },
    );
    return () => {
      live = false;
    };
  }, [cloudTarget, settingsOpen, jarvisSettingsOpen]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, partial, pendingApproval, toolResults, consentCard, revokedLink, preparing]);

  // A card names one connection. Another chosen meanwhile ends it: the
  // question asks again, for the connection it would now go to.
  useEffect(() => {
    setConsentCard(null);
  }, [cloudTarget]);

  /** Save messages to the conversation their turn began in. A conversation
      cleared or deleted since then refuses the write where it commits; that
      refusal is the erase working. Any other loss is said on screen, so a
      message that will be gone after a restart does not look kept. */
  const saveTurn = (
    target: ActiveConversation,
    requestId: string,
    added: NewMessage[],
  ) => {
    const lost = () => {
      if (activeRef.current?.id === target.id) setNotSaved(true);
    };
    appendTurn(db, {
      conversationId: target.id,
      expectedEraseRevision: target.eraseRevision,
      requestId,
      messages: added,
    }).then(
      (result) => {
        if (result.ok) return;
        const now = db.collection("conversations").get(target.id);
        if (now && now.eraseRevision === target.eraseRevision) lost();
      },
      (caught: unknown) => {
        console.error("assistant transcript not saved", caught);
        lost();
      },
    );
  };

  /* The newest probe wins, so a slow earlier answer cannot overwrite a newer
     one. Only while enabled: switched off, or with Jarvis talking through a
     cloud connection, the local engine is asked nothing. */
  const checkReadiness = async () => {
    const probe = ++healthProbeRef.current;
    setCheckingHealth(true);
    try {
      const report = await localAssistant.checkHealth({
        localAssistantEnabled: true,
        ollamaModel: localModel,
      });
      if (probe === healthProbeRef.current) setHealth(report);
    } finally {
      if (probe === healthProbeRef.current) setCheckingHealth(false);
    }
  };
  const onReadinessInputs = useEffectEvent(() => {
    void checkReadiness();
  });
  useEffect(() => {
    if (!prefs.localAssistantEnabled || cloud) {
      healthProbeRef.current += 1;
      setHealth(null);
      setCheckingHealth(false);
      return;
    }
    onReadinessInputs();
  }, [prefs.localAssistantEnabled, localModel, cloud]);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  /**
   * What a cloud turn about an investigation needs first. A conversation whose history carries a summary goes on only
   * while the investigation allows the connection it would go to. Else the
   * first question of a linked conversation carries the summary: at once
   * when the investigation allows this connection, after the consent card
   * otherwise. `allowed` is a card the user just allowed; it holds only for
   * the conversation it was shown in and the connection it named. Nothing
   * here touches the screen: the turn shows what comes back only if it is
   * still in the conversation it began in.
   */
  const prepareLinked = async (
    linkedId: string | null,
    holdsSummary: boolean,
    target: AiTarget,
    question: string,
    conversationId: string,
    allowed: ConsentCardState | undefined,
  ): Promise<Prepared> => {
    const status = await aiConnections.keyStatus(target).catch(() => null);
    const connection = { provider: providerId(target), host: hostOf(status?.baseUrl) };
    // A connection whose key or address cannot be read is no connection to
    // name on a card or to allow: nothing is prepared for it.
    if (status?.present === false) {
      return { go: false, error: t("jarvis.cloud.noKey", { name: connectionName(t, target) }) };
    }
    if (status?.present !== true || connection.host === "") {
      return { go: false, error: t("jarvis.consent.prepFailed") };
    }
    // Read after every await, so a revoke meanwhile counts.
    const allows = () => {
      const engagement = linkedId ? db.collection("engagements").get(linkedId) : undefined;
      return engagement ? consentMatches(engagement, connection) : false;
    };
    if (holdsSummary) {
      if (allows()) return { go: true };
      return linkedId
        ? { go: false, revoked: linkedId }
        : { go: false, error: t("jarvis.consent.revoked") };
    }
    const engagement = linkedId ? db.collection("engagements").get(linkedId) : undefined;
    if (!linkedId || !engagement) return { go: true };
    if (
      allowed &&
      allowed.conversationId === conversationId &&
      allowed.engagementId === linkedId &&
      targetKey(allowed.target) === targetKey(target) &&
      sameConnection(allowed.connection, connection)
    ) {
      try {
        await grantCloudConsent(linkedId, connection);
      } catch (caught) {
        console.error("cloud allowance not kept", caught);
        return { go: false, error: t("jarvis.consent.notKept") };
      }
      return { go: true, context: allowed.summary };
    }
    try {
      const summary = await loadInvestigationSummary(linkedId, t, locale);
      if (!summary) return { go: true };
      if (allows()) return { go: true, context: summary };
      const preview = await aiConnections.maskPreview(summary);
      return {
        go: false,
        card: {
          question,
          summary,
          preview,
          connection,
          target,
          name: connectionName(t, target),
          conversationId,
          engagementId: linkedId,
          title: engagement.title,
          // One allowance per investigation: another connection's is replaced.
          ...(engagement.cloudConsent ? { replaces: engagement.cloudConsent.host } : {}),
        },
      };
    } catch {
      return { go: false, error: t("jarvis.consent.prepFailed") };
    }
  };

  /** The consent card's "Allow and send": the question goes with the
      summary the card showed, and the allowance is kept for this
      investigation and the connection the card named. */
  const allowSummary = () => {
    if (!consentCard) return;
    inputRef.current?.focus();
    void send(consentCard.question, consentCard);
  };

  const cancelSummary = () => {
    setConsentCard(null);
    inputRef.current?.focus();
  };

  /** A new conversation about the same investigation, after a revoke. The
      notice's button goes away, so the composer takes the focus. */
  const startLinked = (engagementId: string) => {
    setRevokedLink(null);
    inputRef.current?.focus();
    createConversation(db, { engagementId }).catch((caught: unknown) =>
      console.error("conversation not created", caught),
    );
  };

  /** Send the draft, or `override` (the cut-off answer's Continue, a
      consent card's question) without touching the draft. `allowed` is the
      consent card the user allowed. */
  const send = async (override?: string, allowed?: ConsentCardState) => {
    const text = (override ?? draft).trim();
    if (!text || streaming || erase === "pending" || cloudBlocked || preparingRef.current) return;
    // A conversation holding Claude answers is never trimmed at its start,
    // so at the cap it ends here rather than being refused by Rust.
    if (cloud && messages.length >= MAX_CLOUD_CONVERSATION_MESSAGES) {
      setError(t("jarvis.cloud.error.tooLong"));
      return;
    }
    // Captured now: Settings may change the connection while the turn runs.
    const turnTarget = cloudTarget;
    const turnModel = cloudModel;
    const turnLocalModel = localModel;
    const turnWeb = webOn;
    // A card allowed for the cloud never sends its question elsewhere.
    if (allowed && !turnTarget) {
      setConsentCard(null);
      return;
    }
    // The conversation and the clear the turn began with. Preparing a
    // question about an investigation awaits; a conversation opened or
    // cleared meanwhile drops the question rather than mixing the two.
    const began = activeRef.current;
    const epoch = turnEpochRef.current;

    let summary: string | undefined;
    const linkedId = began
      ? (conversations.find((c) => c.id === began.id)?.engagementId ?? null)
      : null;
    const holdsSummary = historyHoldsSummary(messages);
    if (turnTarget && (linkedId || holdsSummary)) {
      preparingRef.current = true;
      setPreparing(true);
      setError("");
      setRevokedLink(null);
      let prepared: Prepared;
      try {
        prepared = await prepareLinked(
          linkedId,
          holdsSummary,
          turnTarget,
          text,
          began?.id ?? "",
          allowed,
        );
      } finally {
        preparingRef.current = false;
        setPreparing(false);
      }
      if (activeRef.current !== began || turnEpochRef.current !== epoch) return;
      if (!prepared.go) {
        if (prepared.card) {
          setConsentCard(prepared.card);
          setAnnouncement(t("jarvis.consent.announce", { title: prepared.card.title }));
        }
        if (prepared.revoked) setRevokedLink(prepared.revoked);
        if (prepared.error) setError(prepared.error);
        return;
      }
      summary = prepared.context;
    }

    // The first question that goes to the cloud carries Jarvis's memory and
    // instructions; the conversation keeps them for the turns after it.
    const carried =
      turnTarget && personal && !messages.some((m) => m.role === "user" && m.personal)
        ? personal
        : undefined;
    const pickedSkill = skillById(skillId);
    const skillText = pickedSkill ? skillInstruction(pickedSkill) : undefined;
    const asked: AssistantMessage = {
      role: "user",
      content: text,
      ...(summary ? { context: summary } : {}),
      ...(carried ? { personal: carried } : {}),
      ...(skillText ? { skill: skillText } : {}),
    };
    const next: AssistantMessage[] = [...messages, asked];
    setMessages(next);
    setConsentCard(null);
    // The draft was the card's question, unless the user changed it meanwhile.
    // Read now, not from when the question was asked: what was typed while
    // it was being prepared stays.
    if (override === undefined || allowed) {
      setDraft((current) => (current.trim() === text ? "" : current));
    }
    // A skill serves the question it was picked for, not the ones after it.
    setSkillId(null);
    setError("");
    setPartial("");
    setPendingApproval(null);
    setToolResults([]);
    setTurnBinding(null);
    setCloudBound(null);
    setCloudNote(null);
    setNotSaved(false);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = globalThis.crypto?.randomUUID?.() ?? createId("req");
    // What Rust bound this turn to, kept with the answer it produces.
    const turn: { binding: TurnBinding | null; sources: WebSource[] } = {
      binding: null,
      sources: [],
    };
    // A terminal tool-path error (a rejected or
    // unrecognized tool call, a tool that failed, too many steps, ...) does
    // not make `streamChat` reject -- it resolves with whatever prose
    // already streamed, and reports the failure through `onError` instead,
    // captured here so it can be shown once the `await` below settles.
    let toolPathErrorCode: string | null = null;
    let target = began;
    /** Whether the conversation this turn began in is still on screen. */
    const here = () => target !== null && activeRef.current?.id === target.id;

    try {
      if (!target) {
        const created = await createConversation(db);
        if (turnEpochRef.current !== epoch) return;
        target = { id: created.id, eraseRevision: created.eraseRevision };
        adopt(target);
        // Showing the new, empty document may have replaced the question.
        setMessages(next);
      }
      turnRef.current = target;
      setTurnConversationId(target.id);
      // Saved now, so a question survives a turn that never finishes.
      saveTurn(target, requestId, [
        {
          role: "user",
          content: text,
          ...(summary ? { context: summary } : {}),
          ...(carried ? { personal: carried } : {}),
          ...(skillText ? { skill: skillText } : {}),
        },
      ]);

      if (turnTarget) {
        turnKindRef.current = "cloud";
        const live = () => turnEpochRef.current === epoch;
        // Where Rust sent the turn, and what streamed before any stop.
        const sent: { bound: CloudBound | null; text: string } = { bound: null, text: "" };
        try {
          // The conversation, an investigation's summary in it only after
          // its consent card. Rust masks secrets first.
          const provider = providerId(turnTarget);
          const conversationId = target.id;
          const result = await streamCloudChat(turnTarget, turnModel, cloudHistory(next), {
            requestId,
            signal: controller.signal,
            onBound: (bound) => {
              sent.bound = { ...bound, provider };
              if (live()) setCloudBound(sent.bound);
              // The question as it went out is kept, so later turns send it
              // exactly so (append-only history): in the document, and in
              // `next`, which the answer is added to.
              markSent(db, { conversationId, requestId, sentText: bound.sentText }).catch(
                (caught: unknown) => console.error("sent question not kept", caught),
              );
              const asked = next.length - 1;
              next[asked] = {
                ...next[asked]!,
                cloudSent: true,
                ...(bound.sentText !== undefined && bound.sentText !== text
                  ? { cloudContent: bound.sentText }
                  : {}),
              };
              // Shown at once: a question that went with a summary says so.
              if (live() && here()) setMessages([...next]);
            },
            onToken: (chunk) => {
              sent.text += chunk;
              if (!live()) return;
              setCloudNote(null);
              setPartial((prev) => prev + chunk);
            },
            onThinking: () => {
              if (live()) setCloudNote({ kind: "thinking" });
            },
            onSearching: () => {
              if (live()) setCloudNote({ kind: "searching" });
            },
            ...(turnWeb ? { webAccess: true } : {}),
            onRetrying: (seconds) => {
              if (live()) setCloudNote({ kind: "retrying", seconds });
            },
            onFallback: (from, to) => {
              if (live()) setCloudNote({ kind: "fallback", from, to });
            },
          });
          if (!live()) return;
          const facts = {
            endpoint: sent.bound?.endpoint ?? "",
            provider,
            masked: sent.bound?.masked ?? 0,
            servedBy: result.servedBy ?? turnModel,
            fallbackFrom: result.fallbackFrom,
            sentBytes: sent.bound?.sentBytes ?? 0,
            stop: result.stop,
            refusalCategory: result.refusalCategory,
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
            costUsd: result.usage?.costUsd ?? null,
          };
          const answeredBy = { endpoint: facts.endpoint, model: facts.servedBy };
          // A declined answer's partial text is dropped, never kept as an
          // answer. The decline itself is kept: it says so after a restart,
          // and the question it declined is not sent again (cloudHistory).
          // So is an answer cut off before any text (all of it thinking),
          // which can still be continued.
          const marker = result.stop === "refusal" || (result.stop === "max_tokens" && !result.text);
          const reply: (NewMessage & AssistantMessage) | null = marker
            ? { role: "assistant", content: "", answeredBy, cloud: facts }
            : result.text
              ? {
                  role: "assistant",
                  content: result.text,
                  answeredBy,
                  cloud: facts,
                  ...(result.blocks?.length ? { blocks: result.blocks } : {}),
                  ...(result.sources?.length ? { sources: result.sources } : {}),
                }
              : null;
          if (reply) {
            if (here()) setMessages([...next, reply]);
            saveTurn(target, requestId, [reply]);
          } else if (here()) {
            // Finished, yet nothing to show: never a question left hanging.
            setError(t("settings.cloud.error.unexpected"));
          }
          if (here()) {
            setAnnouncement(
              t(
                result.stop === "refusal" || !reply
                  ? "localAssistant.announceError"
                  : "localAssistant.announceDone",
              ),
            );
          }
        } catch (caught) {
          if (!live()) return;
          // What streamed before Stop or a failure is kept, as on the local
          // path, without blocks: it goes back as plain text.
          if (sent.text) {
            const kept: NewMessage & AssistantMessage = sent.bound
              ? {
                  role: "assistant",
                  content: sent.text,
                  answeredBy: { endpoint: sent.bound.endpoint, model: sent.bound.model },
                }
              : { role: "assistant", content: sent.text };
            if (here()) setMessages([...next, kept]);
            saveTurn(target, requestId, [kept]);
          }
          const code = isAiError(caught) ? caught.code : null;
          if (code === "no_key") {
            // The notice above the composer says it, with the way to Settings.
            setCloudKey({
              target: targetKey(turnTarget),
              status: { present: false, last4: null, baseUrl: null },
            });
          } else if (code !== "cancelled" && here()) {
            if (code === null && !(caught instanceof CloudTurnRefused)) console.error(caught);
            setError(cloudErrorText(t, caught));
            setAnnouncement(t("localAssistant.announceError"));
          }
        }
        return;
      }
      turnKindRef.current = "local";

      /* The context rides along with this turn but is never stored in the
         transcript: it is derived state that would go stale, and keeping it out
         means "clear chat" has nothing extra to miss. */
      // An answer without text (a cloud service's decline, or a cloud answer
      // cut off while thinking) is nothing to show the local model.
      const history = next.filter((m) => m.role !== "assistant" || m.content !== "");
      // On this computer, Jarvis's memory and instructions ride as the
      // system message every turn, ahead of the project context.
      const system = [
        personal,
        skillText ?? "",
        context.text ? contextSystemMessage(context.text, prefs.assistantAgentToolsEnabled) : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const outgoing: AssistantMessage[] = system
        ? [{ role: "system", content: system }, ...history]
        : history;

      const full = await localAssistant.streamChat(
        {
          localAssistantEnabled: prefs.localAssistantEnabled,
          ollamaModel: turnLocalModel,
          ollamaContextTokens: prefs.ollamaContextTokens,
          // Opt-in, default off (ADR 0012, Decision 2). Only ever weakens the
          // gate for the read-only `read_context` tool; the broker asserts in
          // code that it cannot affect `terminal_run` or `launch_tool`.
          autoApproveReads: prefs.assistantAutoApproveReads,
          // Opt-in, default off (ADR 0012). Turns the assistant from
          // an answerer into an agent that can propose a tool call at all;
          // the broker also requires Private Lab consent before it
          // advertises tool schemas for the turn.
          agentToolsEnabled: prefs.assistantAgentToolsEnabled,
          // The conversation's switch: Rust searches (or reads the addresses
          // in the question) and hands the model what it found as untrusted
          // text for this turn only.
          webAccess: turnWeb,
        },
        outgoing,
        {
          signal: controller.signal,
          requestId,
          onBound: (binding) => {
            if (turnEpochRef.current !== epoch) return;
            turn.binding = binding;
            setTurnBinding(binding);
          },
          onStatus: (status) => {
            if (turnEpochRef.current !== epoch) return;
            if (status === "web_searching") setWebSearching(true);
          },
          onWebSources: (sources) => {
            if (turnEpochRef.current !== epoch) return;
            turn.sources = sources;
            setWebSearching(false);
          },
          onToken: (chunk) => {
            if (turnEpochRef.current !== epoch) return;
            setWebSearching(false);
            setPartial((prev) => prev + chunk);
          },
          onToolCall: (event: AssistantStreamEvent) => {
            if (turnEpochRef.current !== epoch) return;
            if (!event.callId) {
              // Malformed: a proposal with nothing to key a card -- or its
              // resolution -- on. Silently waiting out the full approval
              // deadline with no explanation is worse than saying something
              // went wrong now.
              console.error("assistant tool_call event missing callId", event);
              setError(assistantErrorMessage(t, "internal"));
              setAnnouncement(t("localAssistant.announceError"));
              return;
            }
            setPendingApproval({
              requestId: event.requestId,
              callId: event.callId,
              summary: event.summary ?? "",
              tool: event.status ?? "",
              ...(event.action ? { action: event.action } : {}),
              decision: "awaiting",
            });
            // The turn is now blocked on a human decision -- the polite
            // status region must say so, not keep claiming "Generating...".
            setAnnouncement(
              t("jarvis.approval.announce", { summary: event.summary ?? "" }),
            );
          },
          onToolResult: (event: AssistantStreamEvent) => {
            if (turnEpochRef.current !== epoch) return;
            setPendingApproval((prev) =>
              prev && prev.callId === event.callId ? null : prev,
            );
            setToolResults((prev) => [
              ...prev,
              { callId: event.callId ?? "", summary: event.summary ?? "" },
            ]);
            // `sessionId` is only ever set on a `terminal_run` result
            // (`ToolOutcome::session_id`, `src-tauri/src/assistant/tools.rs`)
            // -- present whether the call wrote to an existing session or
            // opened a fresh one. Opening a tab here does not navigate the
            // user to it: they stay on this chat mid-conversation, and can
            // switch to the Terminal page to look whenever they choose.
            //
            // Ordering note: this tab attaches *after* the command has
            // already been written to the PTY (`tool_result` is emitted
            // once `execute` returns, and the shell runs asynchronously
            // from there). There is no output buffer on the Rust side, so
            // any bytes the command already produced before this listener
            // subscribes are not replayed -- in practice that window is
            // small, but it is a race, not a guarantee. This tab's
            // scrollback should be treated as "from roughly now", not as a
            // complete transcript of everything the command did.
            if (event.sessionId) {
              openAttachedTab({
                sessionId: event.sessionId,
                title: t("jarvis.terminal.attachedTitle"),
              });
            }
          },
          onError: (caught) => {
            if (turnEpochRef.current !== epoch) return;
            // Captured, not acted on yet: `full` (and this turn's `catch`
            // block) is still the source of truth for what gets persisted,
            // so the message is shown only once the `await` below settles.
            toolPathErrorCode = caught.reason;
          },
        },
      );

      if (turnEpochRef.current !== epoch) return;

      // Whatever streamed is kept, including a partial answer after Stop --
      // and whatever streamed before a terminal tool-path error
      // (`toolPathErrorCode` above).
      const reply: NewMessage & AssistantMessage = {
        role: "assistant",
        content: full,
        ...(turn.binding ? { answeredBy: turn.binding } : {}),
        ...(turn.sources.length ? { sources: turn.sources } : {}),
      };
      if (full.length > 0) {
        if (here()) setMessages([...next, reply]);
        saveTurn(target, requestId, [reply]);
      }
      if (toolPathErrorCode && READINESS_CODES.has(toolPathErrorCode)) {
        void checkReadiness();
      }
      if (toolPathErrorCode && here()) {
        // The preserved prose above must not look like a clean, complete
        // answer: this callout (already the app's one error surface, styled
        // as a warning with `role="alert"`) renders right below it, and the
        // live region says "failed" rather than "complete" -- so a sighted
        // user sees both the partial text and the reason it stopped there,
        // and a screen-reader user hears the distinction instead of just
        // "Answer complete".
        setError(assistantErrorMessage(t, toolPathErrorCode));
        setAnnouncement(t("localAssistant.announceError"));
      } else if (!toolPathErrorCode) {
        setAnnouncement(t("localAssistant.announceDone"));
      }
    } catch (caught) {
      if (turnEpochRef.current !== epoch) return;
      // A stopped server must not lose the question the user just typed.
      const isKnownAssistantError =
        caught instanceof AssistantBlockedError || caught instanceof AssistantTimeoutError;
      if (!isKnownAssistantError) {
        // An unrecognized exception (a real bug, a thrown non-Error, an
        // upstream shape change) must not look identical to an expected
        // refusal or timeout -- log it so it is distinguishable later.
        console.error(caught);
      }
      const code =
        caught instanceof AssistantBlockedError
          ? caught.reason
          : caught instanceof AssistantTimeoutError
            ? caught.code
            : "internal";
      if (target === null || here()) {
        setError(assistantErrorMessage(t, code));
        setAnnouncement(t("localAssistant.announceError"));
      }
      // No conversation could be created, so the question is not stored.
      if (target === null) setNotSaved(true);
      if (READINESS_CODES.has(code)) {
        void checkReadiness();
      }
    } finally {
      // Only this turn's controller: after a clear, a newer turn owns it.
      if (abortRef.current === controller) abortRef.current = null;
      if (turnEpochRef.current === epoch) {
        // A card must never outlive its turn -- clear it on any terminal event,
        // `done` or `error` alike, even if no `tool_result` ever arrived (a
        // rejection or an approval timeout ends the turn with neither).
        setPendingApproval(null);
        setStreaming(false);
        setPartial("");
        setWebSearching(false);
        setTurnBinding(null);
        setCloudBound(null);
        setCloudNote(null);
        turnRef.current = null;
        turnKindRef.current = null;
        setTurnConversationId(null);
      }
    }
  };

  const respondToApproval = async (approved: boolean) => {
    const current = pendingApproval;
    if (!current) return;
    // Optimistic: the broker resolves the wait, but the outcome for a
    // side-effecting call still arrives later as its own `tool_result` (or
    // the turn ends in `approval_rejected`) -- this only reflects the
    // decision the user just made, not that anything has run yet.
    setPendingApproval({ ...current, decision: approved ? "approved" : "rejected" });
    await localAssistant.approveTool(current.requestId, current.callId, approved);
  };

  /** End the turn in flight, wherever it began. Clearing a transcript
      without aborting left the broker sitting on an approval whose card the
      UI had already removed, and a late result would write the history back. */
  const cancelTurn = () => {
    turnEpochRef.current += 1;
    releaseBrokerSlot(true);
    setToolResults([]);
    setPendingApproval(null);
    setTurnBinding(null);
    setCloudBound(null);
    setCloudNote(null);
    setPartial("");
    turnRef.current = null;
    turnKindRef.current = null;
    setTurnConversationId(null);
  };

  /** Forget what the screen shows for the previous conversation. */
  const resetView = () => {
    setMessages([]);
    setError("");
    setAnnouncement("");
    setNotSaved(false);
    setConsentCard(null);
    setRevokedLink(null);
  };

  const clear = async () => {
    const target = activeRef.current;
    // A turn of another conversation keeps running; this one's cannot
    // survive its own erase.
    if (!turnRef.current || turnRef.current.id === target?.id) cancelTurn();
    if (!target) {
      resetView();
      return;
    }
    // The revision is raised by the write itself. Until it commits the
    // transcript is still on disk, so it stays on screen and nothing new is
    // sent that could race it.
    setErase("pending");
    setError("");
    try {
      const erased = await clearConversation(db, target.id);
      if (erased && activeRef.current?.id === erased.id) {
        adopt({ id: erased.id, eraseRevision: erased.eraseRevision });
        resetView();
      }
      setErase("idle");
      setAnnouncement(t("localAssistant.cleared"));
    } catch (caught) {
      console.error("assistant conversation not cleared", caught);
      // Nothing was erased, so the held revision is still the stored one and
      // a question asked now is saved as usual. Opened elsewhere meanwhile,
      // the transcript is back on screen when this one is reopened.
      if (activeRef.current?.id === target.id) setErase("failed");
    }
  };

  // The chat outlives the /jarvis route (ADR 0013), so its documents change
  // under it: a conversation opened elsewhere, or erased elsewhere (Settings,
  // later the rail). Follow both. Revisions only rise, so a stored revision
  // above the one held means an erase committed.
  const onDocuments = useEffectEvent(() => {
    const turn = turnRef.current;
    if (turn) {
      const doc = db.collection("conversations").get(turn.id);
      if (!doc || doc.eraseRevision > turn.eraseRevision) cancelTurn();
    }
    const held = activeRef.current;
    if (held && shown?.id === held.id) {
      if (shown.eraseRevision > held.eraseRevision) {
        adopt({ id: shown.id, eraseRevision: shown.eraseRevision });
        resetView();
      }
      return;
    }
    if (!held && !shown) return;
    // Another conversation is selected, or this one is gone.
    adopt(shown ? { id: shown.id, eraseRevision: shown.eraseRevision } : null);
    resetView();
    setErase("idle");
    setMessages(shown ? shown.messages.map(toAssistantMessage) : []);
  });
  useEffect(() => {
    onDocuments();
  }, [conversations]);

  const turnElsewhere =
    streaming && turnConversationId !== null && turnConversationId !== active?.id;
  const busyTitle = turnElsewhere
    ? conversations.find((c) => c.id === turnConversationId)?.title ||
      t("jarvis.conversation.untitled")
    : "";
  const showBusyConversation = () => {
    if (!turnConversationId) return;
    openConversation(db, turnConversationId).catch((caught: unknown) => {
      console.error("assistant conversation not opened", caught);
    });
  };

  /* The surface: the conversation's header, one
     centred transcript column and the composer under it. Setup, before the
     assistant is on, keeps its own page. */
  if (!cloud && (!prefs.localAssistantEnabled || (askPrivateLab && !prefs.privateToolsEnabled))) {
    return (
      <div className="page-body asst-setup">
        {/* A conversation that chose a local model while the default is a
            cloud one: the way back without setting up the local model. */}
        {resolved.own && shown && prefs.aiProvider !== "ollama" && (
          <div className="callout asst-row asst-setup__own">
            <span className="asst-grow">
              {t("jarvis.modelSettings.ownChoice", { name: resolved.model })}
            </span>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() =>
                void setConversationModel(db, shown.id, null).catch((caught: unknown) =>
                  console.error("model choice not cleared", caught),
                )
              }
            >
              {t("jarvis.model.useDefault")}
            </button>
          </div>
        )}
        <div className="asst-setup__card">
          <div className="asst-setup__head">
            <JarvisMark size={26} />
            <div>
              <h2>{t("localAssistant.assistant")}</h2>
              <p className="muted">{t("jarvis.setup.lead")}</p>
            </div>
          </div>
          <AssistantSetup
            askPrivateLab={askPrivateLab && !prefs.privateToolsEnabled}
            onAskPrivateLab={setAskPrivateLab}
          />
        </div>
      </div>
    );
  }

  const activeDoc = active ? conversations.find((c) => c.id === active.id) : undefined;
  const title =
    activeDoc?.title ||
    (messages.length > 0 ? t("jarvis.conversation.untitled") : t("jarvis.conversation.new"));
  const linkedEngagement = activeDoc?.engagementId
    ? engagements.find((e) => e.id === activeDoc.engagementId)
    : undefined;
  const starterEngagement =
    linkedEngagement ??
    [...engagements]
      .filter((e) => e.status !== "archived")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const pick = (prompt: string) => {
    setDraft(prompt);
    inputRef.current?.focus();
  };

  /** Under an answer: where it went -- for a cloud answer also who answered
      and what it cost -- and why a cloud answer stopped short. */
  const answerFooter = (m: AssistantMessage, i: number) => {
    const previous = earlierRecipient(messages, i);
    const pages = m.sources?.length ? <WebSources sources={m.sources} /> : null;
    if (!m.cloud) {
      return (
        <>
          {m.answeredBy && <TurnRecipient binding={m.answeredBy} previous={previous} />}
          {pages}
        </>
      );
    }
    const newest = i === messages.length - 1 && !streaming && cloud;
    return (
      <>
        {pages}
        {m.cloud.stop === "refusal" && (
          <p className="callout callout--warning asst-small" data-testid="assistant-cloud-refusal">
            {refusalText(t, m.cloud.refusalCategory)}
          </p>
        )}
        <CloudAnswerMeta cloud={m.cloud} previous={previous?.endpoint} />
        {m.cloud.stop === "max_tokens" && (
          <CutOffNotice
            onContinue={newest ? () => void send(t("jarvis.cloud.continuePrompt")) : undefined}
          />
        )}
      </>
    );
  };

  return (
    <div className="asst" data-testid="local-assistant-chat">
      <AssistantHeader
        title={title}
        engagement={linkedEngagement}
        endpoint={
          cloud
            ? (cloudBound?.endpoint ?? keyStatus?.baseUrl ?? null)
            : (turnBinding?.endpoint ?? health?.endpoint ?? null)
        }
        cloud={cloud ? { name: cloudName, model: cloudModel } : undefined}
        ready={cloud ? keyStatus?.present === true && cloudModel !== "" : health?.status === "ready"}
        canClear={messages.length > 0}
        clearing={erase === "pending"}
        onClear={() => setConfirmClear(true)}
      />

      {/* Status-only live region. The transcript below is deliberately NOT a
          live region: it re-rendered on every streamed token, so a screen
          reader announced the answer one fragment at a time, which is
          unusable. One announcement when generation starts, one when it ends.

          While a card is pending, the turn is blocked on a human decision,
          not generating -- claiming "Generating..." here would be false, and
          it would leave a screen-reader user with no idea a decision is
          being waited on before the turn dies at `approval_timeout`. */}
      <p className="sr-only" role="status" aria-live="polite">
        {pendingApproval ? announcement : streaming ? t("localAssistant.thinking") : announcement}
      </p>

      <div
        ref={logRef}
        className="asst-log"
        role="log"
        aria-live="off"
        aria-label={t("jarvis.transcript")}
        data-scroll-owner="page"
      >
        <div className="asst-col">
          {/* Readiness stays reachable here: the engine's next
              step and the retry are needed exactly when not ready. */}
          {health && health.status !== "ready" && (
            <AssistantReadiness
              compact
              health={health}
              checking={checkingHealth}
              onCheck={() => void checkReadiness()}
              showCheckButton
            />
          )}
          {!cloud && prefs.assistantAgentAwaitingConfirmation && (
            <div className="asst-notice">
              <RestoreToolProposals />
            </div>
          )}
          {cloud && keyStatus?.present === false && (
            <CloudSetupNotice text={t("jarvis.cloud.noKey", { name: cloudName })} />
          )}
          {cloud && keyStatus?.present !== false && !cloudModel && (
            <CloudSetupNotice text={t("jarvis.cloud.noModel", { name: cloudName })} />
          )}
          {erase === "pending" && (
            <p className="asst-small faint">
              <Loader2 size={13} className="spin" aria-hidden /> {t("localAssistant.clearing")}
            </p>
          )}
          {erase === "failed" && (
            <div className="callout callout--warning asst-row" role="alert">
              <span className="asst-grow">{t("localAssistant.clearFailed")}</span>
              <button type="button" className="btn btn--sm" onClick={() => void clear()}>
                {t("localAssistant.retry")}
              </button>
            </div>
          )}

          {/* Through the cloud the starters stay generic: one naming an
              investigation would send its title, which the cloud does not
              get before the consent card. */}
          {messages.length === 0 && !streaming && !consentCard && !revokedLink && !preparing && (
            <StarterPrompts engagement={cloud ? undefined : starterEngagement} onPick={pick} />
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <Fragment key={i}>
                <UserTurn text={m.content} />
                {(m.context || m.personal || m.skill) && m.cloudSent && (
                  <SentContext
                    kind={m.context ? "summary" : m.skill ? "skill" : "personal"}
                    text={
                      m.cloudContent ??
                      [m.personal, m.skill, m.context, m.content].filter(Boolean).join("\n\n")
                    }
                  />
                )}
              </Fragment>
            ) : (
              <JarvisTurn key={i} text={m.content} footer={answerFooter(m, i)} />
            ),
          )}

          {preparing && (
            <p className="asst-small faint" data-testid="assistant-consent-preparing">
              <Loader2 size={13} className="spin" aria-hidden /> {t("jarvis.consent.preparing")}
            </p>
          )}

          {/* Not while a question is prepared: after "Allow and send" the
              allowance is being kept, and a Cancel then could not undo it. */}
          {consentCard && !streaming && !preparing && (
            <ConsentCard card={consentCard} onAllow={allowSummary} onCancel={cancelSummary} />
          )}

          {revokedLink && (
            <div className="callout callout--warning asst-row" role="alert">
              <span className="asst-grow">{t("jarvis.consent.revoked")}</span>
              <button type="button" className="btn btn--sm" onClick={() => startLinked(revokedLink)}>
                {t("jarvis.consent.newConversation")}
              </button>
            </div>
          )}

          {/* While a local turn waits for the engine to start or load its
              model (ADR 0016), say so instead of looking stuck. */}
          {streaming && !turnElsewhere && !cloud && <LocalEngineActivity />}
          {streaming && !turnElsewhere && (
            <JarvisTurn
              text={partial}
              streaming
              footer={
                cloudBound || cloudNote ? (
                  <CloudTurnStatus bound={cloudBound} note={cloudNote} />
                ) : (
                  <>
                    {webSearching && (
                      <p className="asst-recipient" data-testid="assistant-web-searching">
                        {t("jarvis.web.searching")}
                      </p>
                    )}
                    {turnBinding && (
                      <TurnRecipient
                        binding={turnBinding}
                        previous={earlierRecipient(messages, messages.length)}
                      />
                    )}
                  </>
                )
              }
            />
          )}

          {!turnElsewhere &&
            toolResults.map((entry, i) => (
              <div
                key={`${entry.callId}-${i}`}
                className="asst-result"
                data-testid="assistant-tool-result"
              >
                <div className="asst-lbl">{t("jarvis.approval.result")}</div>
                <p className="asst-result__text">{entry.summary}</p>
              </div>
            ))}

          {/* The inline approval card (ADR 0012, Decision 2). Everything in it
              is a plain React child, never dangerouslySetInnerHTML -- markup in
              a proposal must render as inert text, so a proposal can never
              disguise what it is asking for. */}
          {pendingApproval && !turnElsewhere && (
            <ApprovalCard
              approval={pendingApproval}
              onDecide={(approved) => void respondToApproval(approved)}
            />
          )}

          {error && (
            <p className="callout callout--warning asst-small" role="alert">
              {error}
            </p>
          )}

          {notSaved && (
            <p className="callout callout--warning asst-small" role="alert">
              {t("localAssistant.notSaved")}
            </p>
          )}

          {/* One turn at a time (the broker's single-flight slot). Opening another
              conversation does not end it; this says where it runs and offers the
              two ways out, instead of a send that would only be refused. */}
          {turnElsewhere && (
            <div className="callout asst-row asst-small" data-testid="assistant-busy-elsewhere">
              <span className="asst-grow">
                {/* The card itself stays with its turn; only the way back is here. */}
                {pendingApproval?.decision === "awaiting"
                  ? t("jarvis.conversation.approvalElsewhere", { title: busyTitle })
                  : t("jarvis.conversation.busyElsewhere", { title: busyTitle })}
              </span>
              <button type="button" className="btn btn--sm" onClick={showBusyConversation}>
                {t("jarvis.conversation.show")}
              </button>
              <button type="button" className="btn btn--sm" onClick={stop}>
                <Square size={13} aria-hidden /> {t("localAssistant.stop")}
              </button>
            </div>
          )}
        </div>
      </div>

      <Composer
        draft={draft}
        onDraft={setDraft}
        onSend={() => void send()}
        onStop={stop}
        streaming={streaming && !turnElsewhere}
        sendDisabled={!draft.trim() || erase === "pending" || turnElsewhere || cloudBlocked}
        inputRef={inputRef}
        chips={
          <>
            <SkillPicker value={skillId} onChange={setSkillId} />
            {webOn && cloud && <WebChip cloudName={cloudName} />}
            {!cloud && (
              <>
                <AssistantModeChips onAskPrivateLab={setAskPrivateLab} />
                <ContextDisclosure context={context} projectId={projectId} />
              </>
            )}
          </>
        }
        badge={
          cloud ? (
            <CloudBadge
              name={cloudName}
              linked={linkedEngagement !== undefined}
              personal={personal !== ""}
            />
          ) : webOn ? (
            <WebChip cloudName={null} />
          ) : undefined
        }
        model={<ModelChip conversationId={active?.id ?? null} resolved={resolved} />}
        web={<WebToggle conversationId={active?.id ?? null} on={webOn} available={webCan} />}
      />
      <ConfirmDialog
        open={confirmClear}
        danger
        title={t("localAssistant.clearConfirmTitle")}
        body={t("localAssistant.clearConfirmBody")}
        confirmLabel={t("localAssistant.clearChat")}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          void clear();
        }}
      />
    </div>
  );
}
