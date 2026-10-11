import { AlertTriangle, Cloud } from "lucide-react";
import type { SavedMessage } from "@/domain/conversations";
import { formatBytes } from "@/features/lab/toolLabels";
import { OPENAI_PRESETS, isAiError, type AiTarget } from "@/lib/aiConnections";
import { aiErrorText } from "@/lib/aiErrorText";
import { CloudTurnRefused, type CloudBound } from "@/lib/cloudAssistant";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";

/* Jarvis through a cloud connection: what each answer says about
   where the conversation went, and the notices that lead to Settings. The
   turn itself runs in LocalAssistantChat. */

type Translate = ReturnType<typeof useT>["t"];

/** A cloud answer's facts, as stored with it. */
export type CloudFacts = NonNullable<SavedMessage["cloud"]>;

/** What a cloud turn in flight is waiting on, before or between its words. */
export type CloudNote =
  | { kind: "thinking" }
  | { kind: "retrying"; seconds: number }
  | { kind: "fallback"; from: string; to: string };

/** The connection's name as Settings shows it. */
export function connectionName(t: Translate, target: AiTarget): string {
  if (target.provider === "anthropic") return t("settings.cloud.anthropicName");
  return target.preset === "custom"
    ? t("settings.cloud.compatName")
    : t(`settings.cloud.preset.${target.preset}`);
}

/** The connection's id as an answer's facts keep it: `anthropic` or the
    OpenAI-compatible preset. */
export function providerId(target: AiTarget): string {
  return target.provider === "anthropic" ? "anthropic" : target.preset;
}

/** A kept provider id by name, or null for one this build does not know. */
function providerName(t: Translate, provider: string): string | null {
  if (provider === "anthropic") return connectionName(t, { provider: "anthropic" });
  const preset = OPENAI_PRESETS.find((p) => p === provider);
  return preset ? connectionName(t, { provider: "openai_compat", preset }) : null;
}

/** "Sent: <provider> · <host> · <size>", and how many secrets were masked.
    An older stored answer has no provider and names the host only. */
function sentLine(
  t: Translate,
  locale: string,
  facts: { provider?: string; endpoint: string; sentBytes: number; masked?: number },
): string {
  const size = formatBytes(facts.sentBytes, locale);
  const name = facts.provider ? providerName(t, facts.provider) : null;
  const line = name
    ? t("jarvis.cloud.sentTo", { provider: name, host: facts.endpoint, size })
    : t("jarvis.cloud.sent", { endpoint: facts.endpoint, size });
  return facts.masked ? `${line} · ${t("jarvis.cloud.masked", { count: facts.masked })}` : line;
}

const usd = (value: number, locale: string) =>
  value.toLocaleString(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  });

/** Under a cloud answer: who answered, where the conversation went and how
    much of it, and what the answer cost by the dated price table. */
export function CloudAnswerMeta({ cloud, previous }: { cloud: CloudFacts; previous?: string }) {
  const { t, locale } = useT();
  const parts = [
    t("jarvis.cloud.answeredBy", { model: cloud.servedBy }),
    sentLine(t, locale, cloud),
  ];
  if (cloud.costUsd !== null) {
    parts.push(t("jarvis.cloud.cost", { cost: usd(cloud.costUsd, locale) }));
  }
  if (cloud.inputTokens > 0 || cloud.outputTokens > 0) {
    parts.push(
      t("jarvis.cloud.tokens", {
        input: cloud.inputTokens.toLocaleString(locale),
        output: cloud.outputTokens.toLocaleString(locale),
      }),
    );
  }
  return (
    <>
      {cloud.fallbackFrom && (
        <p className="callout asst-small" data-testid="assistant-cloud-fallback">
          {t("jarvis.cloud.fallback", { from: cloud.fallbackFrom, to: cloud.servedBy })}
        </p>
      )}
      <p className="asst-recipient" data-testid="assistant-cloud-meta">
        {parts.join(" · ")}
      </p>
      {previous !== undefined && previous !== cloud.endpoint && (
        <p
          className="callout callout--warning asst-small"
          data-testid="assistant-turn-recipient-changed"
        >
          <AlertTriangle size={13} aria-hidden />{" "}
          {t("jarvis.turn.recipientChanged", { previous })}
        </p>
      )}
    </>
  );
}

/** Under a cloud answer still being written: where it went, and what it is
    waiting on. */
export function CloudTurnStatus({
  bound,
  note,
}: {
  bound: CloudBound | null;
  note: CloudNote | null;
}) {
  const { t, locale } = useT();
  return (
    <>
      {note && (
        <p className="asst-recipient" data-testid="assistant-cloud-note">
          {note.kind === "thinking"
            ? t("jarvis.cloud.thinking")
            : note.kind === "retrying"
              ? t("jarvis.cloud.retrying", { seconds: note.seconds })
              : t("jarvis.cloud.fallingBack", { from: note.from, to: note.to })}
        </p>
      )}
      {bound && (
        <p className="asst-recipient" data-testid="assistant-cloud-bound">
          {sentLine(t, locale, bound)}
        </p>
      )}
    </>
  );
}

/** A connection that cannot answer yet, with the way to fix it. */
export function CloudSetupNotice({ text }: { text: string }) {
  const { t } = useT();
  const openSettings = useUi((state) => state.openSettings);
  return (
    <div className="callout asst-row asst-small" data-testid="assistant-cloud-setup">
      <span className="asst-grow">{text}</span>
      <button type="button" className="btn btn--sm" onClick={() => openSettings("ai")}>
        {t("jarvis.cloud.openSettings")}
      </button>
    </div>
  );
}

/** An answer cut off at its length limit; the newest one can be continued. */
export function CutOffNotice({ onContinue }: { onContinue?: () => void }) {
  const { t } = useT();
  return (
    <div className="callout asst-row asst-small" data-testid="assistant-cloud-cut-off">
      <span className="asst-grow">{t("jarvis.cloud.cutOff")}</span>
      {onContinue && (
        <button type="button" className="btn btn--sm" onClick={onContinue}>
          {t("jarvis.cloud.continue")}
        </button>
      )}
    </div>
  );
}

/** In place of "Local only": what goes out, and to whom. The first question
    of a conversation also carries the user's memory and instructions when
    there are any (`personal`); one about an investigation may carry its
    summary, once allowed (`linked`). */
export function CloudBadge({
  name,
  linked = false,
  personal = false,
}: {
  name: string;
  linked?: boolean;
  personal?: boolean;
}) {
  const { t } = useT();
  const key = linked
    ? personal
      ? "jarvis.cloud.chipLinkedPersonal"
      : "jarvis.cloud.chipLinked"
    : personal
      ? "jarvis.cloud.chipPersonal"
      : "jarvis.cloud.chip";
  return (
    <span
      className="asst-chip asst-chip--neutral asst-chip--fit"
      title={t("settings.cloud.jarvisUsesHint")}
      data-testid="assistant-cloud-badge"
    >
      <Cloud size={12} aria-hidden />
      <span className="asst-chip__text">{t(key, { name })}</span>
    </span>
  );
}

/** A declined question, by the service's category. */
export function refusalText(t: Translate, category: string | null): string {
  const named =
    category === "cyber"
      ? "cyber"
      : category === "bio"
        ? "bio"
        : category === "reasoning_extraction"
          ? "reasoning"
          : "other";
  return t("jarvis.cloud.refusal", { category: t(`jarvis.cloud.category.${named}`) });
}

/** Why a cloud turn did not finish, in plain words. */
export function cloudErrorText(t: Translate, error: unknown): string {
  if (error instanceof CloudTurnRefused) {
    if (error.reason === "busy") return t("jarvis.cloud.error.busyTurn");
    if (error.reason === "request_too_large") return t("jarvis.cloud.error.tooLong");
    return t("settings.cloud.error.unexpected");
  }
  if (!isAiError(error)) return t("settings.cloud.error.unexpected");
  if (error.code === "timeout") return t("jarvis.cloud.error.timeout");
  if (error.code === "too_large") return t("jarvis.cloud.error.tooLong");
  return aiErrorText(t, error);
}
