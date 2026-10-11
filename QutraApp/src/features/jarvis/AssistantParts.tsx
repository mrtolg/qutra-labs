import { lazy, Suspense, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUp, Cloud, Cpu, Loader2, Lock, Square, Trash2, Volume2 } from "lucide-react";
import type { Engagement } from "@/domain/lab";
import type { TurnBinding } from "@/lib/localAssistant/client";
import { useT } from "@/lib/i18n";
import { friendlyModelName } from "@/lib/modelNames";
import { speak, speechAvailable, stopSpeaking } from "@/lib/voice/speech";
import { useSpeakingId } from "@/lib/voice/useSpeech";

/* The pieces of the Assistant surface: header,
   turns, starter prompts and composer. The turn logic stays in
   LocalAssistantChat; these only lay it out. */

// Markdown lives in its own chunk; a turn shows its plain
// text until the chunk has loaded.
const Markdown = lazy(() => import("./Markdown"));

/** Jarvis's mark: a hexagon with a core. */
export function JarvisMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="asst-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M8 1.3 13.8 4.65v6.7L8 14.7 2.2 11.35v-6.7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" fill="currentColor" />
    </svg>
  );
}

const hostOf = (endpoint: string) => endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");

export function AssistantHeader({
  title,
  engagement,
  endpoint,
  cloud,
  ready,
  canClear,
  clearing,
  onClear,
}: {
  title: string;
  engagement: Engagement | undefined;
  endpoint: string | null;
  /** Set when Jarvis talks through a cloud connection. */
  cloud?: { name: string; model: string };
  /** Green only once a check found the assistant ready. */
  ready: boolean;
  canClear: boolean;
  clearing: boolean;
  onClear: () => void;
}) {
  const { t } = useT();
  return (
    <header className="asst-h">
      <div className="asst-h__t">
        <h2 className="asst-title">{title}</h2>
        {engagement && (
          <Link className="asst-sub" to={`/lab?e=${encodeURIComponent(engagement.id)}&view=overview`}>
            {engagement.title}
          </Link>
        )}
      </div>
      <div className="asst-h__end">
        {cloud ? (
          <span
            className={ready ? "asst-chip asst-chip--ok" : "asst-chip"}
            data-testid="assistant-live-endpoint"
            title={[endpoint, cloud.model].filter(Boolean).join(" · ") || undefined}
          >
            <Cloud size={12} aria-hidden />
            {cloud.model
              ? (friendlyModelName(cloud.model) ?? `${cloud.name} · ${cloud.model}`)
              : cloud.name}
          </span>
        ) : (
          <>
            {/* The address Rust picked for the last check or turn, never
                typed here: it is a pinned constant (ADR 0012, Decision 3). */}
            <span
              className={ready ? "asst-chip asst-chip--ok" : "asst-chip"}
              data-testid="assistant-live-endpoint"
              title={t("localAssistant.identityUnverified")}
            >
              <Cpu size={12} aria-hidden />
              {endpoint
                ? t("jarvis.header.localAt", { endpoint: hostOf(endpoint) })
                : t("jarvis.header.local")}
            </span>
          </>
        )}
        {canClear && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClear} disabled={clearing}>
            <Trash2 size={13} aria-hidden /> {t("localAssistant.clearChat")}
          </button>
        )}
      </div>
    </header>
  );
}

/** The recipient of the nearest earlier answer, to show a change of address
    between answers instead of leaving the user to compare lines. */
export function earlierRecipient(
  messages: readonly { role: string; answeredBy?: TurnBinding }[],
  before: number,
): TurnBinding | undefined {
  for (let i = before - 1; i >= 0; i -= 1) {
    const answeredBy = messages[i]?.answeredBy;
    if (messages[i]?.role === "assistant" && answeredBy) return answeredBy;
  }
  return undefined;
}

/** Where one answer's turn was sent: the origin and model Rust bound, which
    can differ from the last health check. A different address
    from the previous answer is called out, with an icon and a word. */
export function TurnRecipient({
  binding,
  previous,
}: {
  binding: TurnBinding;
  previous?: TurnBinding;
}) {
  const { t } = useT();
  const changed = previous !== undefined && previous.endpoint !== binding.endpoint;
  return (
    <>
      <p className="asst-recipient" data-testid="assistant-turn-recipient">
        {t("jarvis.turn.recipient", { model: binding.model, endpoint: binding.endpoint })}
      </p>
      {changed && (
        <p
          className="callout callout--warning asst-small"
          data-testid="assistant-turn-recipient-changed"
        >
          <AlertTriangle size={13} aria-hidden />{" "}
          {t("jarvis.turn.recipientChanged", { previous: previous.endpoint })}
        </p>
      )}
    </>
  );
}

export function UserTurn({ text }: { text: string }) {
  const { t } = useT();
  return (
    <div className="asst-turn asst-turn--you">
      <div className="asst-lbl">{t("localAssistant.you")}</div>
      {/* What the user typed, as typed. */}
      <div className="asst-bubble">{text}</div>
    </div>
  );
}

/** Reads one finished answer aloud, or stops it while it is being read. */
function SpeakButton({ text, id }: { text: string; id: string }) {
  const { t } = useT();
  const reading = useSpeakingId() === id;
  const label = reading ? t("voice.stop") : t("voice.read");
  return (
    <button
      type="button"
      className="btn btn--icon btn--sm asst-speak"
      aria-label={label}
      title={label}
      aria-pressed={reading}
      data-testid="assistant-speak"
      onClick={() => (reading ? stopSpeaking() : speak(text, { id }))}
    >
      {reading ? <Square size={13} aria-hidden /> : <Volume2 size={14} aria-hidden />}
    </button>
  );
}

export function JarvisTurn({
  text,
  streaming = false,
  speechId,
  footer,
}: {
  text: string;
  streaming?: boolean;
  /** Names this answer's speech; without it (or while it streams) there is no speaker button. */
  speechId?: string;
  footer?: ReactNode;
}) {
  const { t } = useT();
  return (
    <div className="asst-turn asst-turn--jarvis">
      <div className="asst-who">
        <JarvisMark />
        <span className="asst-lbl asst-lbl--jarvis">{t("localAssistant.assistant")}</span>
        {speechId && !streaming && text && speechAvailable() && (
          <SpeakButton text={text} id={speechId} />
        )}
      </div>
      <div className="asst-prose">
        {text ? (
          <Suspense fallback={<p className="asst-plain">{text}</p>}>
            <Markdown text={text} />
          </Suspense>
        ) : streaming ? (
          <p className="asst-thinking">
            <Loader2 size={13} className="spin" aria-hidden /> {t("localAssistant.thinking")}
          </p>
        ) : null}
      </div>
      {footer}
    </div>
  );
}

/** An empty conversation offers three things to ask, drawn from the open
    engagement when there is one (not a greeting). Choosing one fills
    the composer; nothing is sent until the user sends it. */
export function StarterPrompts({
  engagement,
  onPick,
}: {
  engagement: Engagement | undefined;
  onPick: (text: string) => void;
}) {
  const { t } = useT();
  const prompts = engagement
    ? [
        t("jarvis.starter.scope", { name: engagement.title }),
        t("jarvis.starter.findings", { name: engagement.title }),
        t("jarvis.starter.next"),
      ]
    : [t("jarvis.starter.nmap"), t("jarvis.starter.gitleaks"), t("jarvis.starter.homeLab")];
  return (
    <section className="asst-start" aria-labelledby="asst-start-title">
      <JarvisMark size={28} />
      <h3 id="asst-start-title" className="asst-start__t">
        {t("jarvis.starter.title")}
      </h3>
      <div className="asst-start__list">
        {prompts.map((prompt) => (
          <button key={prompt} type="button" className="asst-start__p" onClick={() => onPick(prompt)}>
            {prompt}
          </button>
        ))}
      </div>
    </section>
  );
}

export function Composer({
  draft,
  onDraft,
  onSend,
  onStop,
  streaming,
  sendDisabled,
  inputRef,
  chips,
  badge,
  model,
  web,
}: {
  draft: string;
  onDraft: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  sendDisabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  chips: ReactNode;
  /** In place of "Local only" when the conversation leaves this computer. */
  badge?: ReactNode;
  /** The model chip, first under the box. */
  model?: ReactNode;
  /** The "İnternet" switch, after the model chip. */
  web?: ReactNode;
}) {
  const { t } = useT();
  return (
    <div className="asst-composer">
      <div className="asst-composer__col">
        <div className="asst-composer__top">
          <label className="asst-composer__label" htmlFor="jarvis-message">
            {t("localAssistant.messageLabel")}
          </label>
          <span className="asst-hint">
            <kbd className="kbd">Enter</kbd> {t("jarvis.composer.toSend")} ·{" "}
            <kbd className="kbd">Shift Enter</kbd> {t("jarvis.composer.newline")}
          </span>
        </div>
        <div className="asst-box">
          <textarea
            id="jarvis-message"
            ref={inputRef}
            className="asst-input"
            rows={1}
            value={draft}
            placeholder={t("localAssistant.chatPlaceholder")}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSend();
              } else if (e.key === "Escape" && streaming) {
                // Cancel without reaching for the mouse.
                e.preventDefault();
                onStop();
              }
            }}
          />
          {streaming ? (
            <button
              type="button"
              className="asst-send asst-send--stop"
              onClick={onStop}
              aria-label={t("localAssistant.stop")}
              title={t("localAssistant.stop")}
            >
              <Square size={13} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className="asst-send"
              onClick={onSend}
              disabled={sendDisabled}
              aria-label={t("localAssistant.send")}
              title={t("localAssistant.send")}
            >
              <ArrowUp size={16} aria-hidden />
            </button>
          )}
        </div>
        <div className="asst-composer__foot">
          {model}
          {web}
          <span className="asst-composer__grow" />
          {chips}
          {badge ?? (
            <span className="asst-chip asst-chip--neutral" title={t("localAssistant.historyLocal")}>
              <Lock size={12} aria-hidden />
              {t("jarvis.composer.localOnly")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
