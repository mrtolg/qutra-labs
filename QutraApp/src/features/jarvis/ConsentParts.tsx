import { useEffect, useRef } from "react";
import { Cloud } from "lucide-react";
import { formatBytes } from "@/features/lab/toolLabels";
import type { AiTarget, MaskPreview } from "@/lib/aiConnections";
import type { CloudConnection } from "@/lib/cloudConsent";
import { useT } from "@/lib/i18n";

/* The first cloud question about an investigation waits on this card until
   the user allows the investigation's summary to go (spec D9, §7.5). The
   card shows the question, the summary as
   Rust will send it, masked, its size and where it goes. */

export interface ConsentCardState {
  /** The question that waits. */
  question: string;
  /** The summary as the app built it; Rust masks it again when it goes. */
  summary: string;
  /** The summary as it will leave. */
  preview: MaskPreview;
  /** The connection the card names: an allowance given here holds for it
      only, so another one chosen meanwhile asks again. */
  connection: CloudConnection;
  target: AiTarget;
  /** The connection's name as Settings shows it. */
  name: string;
  /** The conversation the question was asked in. */
  conversationId: string;
  engagementId: string;
  /** The investigation's title. */
  title: string;
  /** The host of the allowance this one replaces: an investigation keeps
      one, for one connection. */
  replaces?: string;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

export function ConsentCard({
  card,
  onAllow,
  onCancel,
}: {
  card: ConsentCardState;
  onAllow: () => void;
  onCancel: () => void;
}) {
  const { t, locale } = useT();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Nothing goes until the user decides, so the decision takes the focus,
  // as a dialog would; a new card (another question) takes it again.
  useEffect(() => {
    headingRef.current?.focus();
  }, [card]);
  return (
    <section
      className="asst-consent"
      aria-labelledby="asst-consent-title"
      data-testid="assistant-consent-card"
    >
      <h3 id="asst-consent-title" className="asst-consent__title" ref={headingRef} tabIndex={-1}>
        <Cloud size={14} aria-hidden /> {t("jarvis.consent.title", { title: card.title })}
      </h3>
      <p className="asst-small">
        {t("jarvis.consent.lead", {
          name: card.name,
          host: card.connection.host,
          size: formatBytes(bytes(card.preview.text), locale),
        })}
      </p>
      <p className="asst-consent__question">
        <span className="faint">{t("jarvis.consent.question")}</span> {card.question}
      </p>
      {card.preview.masked > 0 && (
        <p className="asst-small">{t("jarvis.cloud.masked", { count: card.preview.masked })}</p>
      )}
      <pre className="asst-consent__text" aria-label={t("jarvis.consent.textLabel")}>
        {card.preview.text}
      </pre>
      <p className="asst-small faint">{t("jarvis.consent.note")}</p>
      {card.replaces && (
        <p className="asst-small">{t("jarvis.consent.replaces", { host: card.replaces })}</p>
      )}
      <div className="asst-row">
        <button type="button" className="btn btn--primary btn--sm" onClick={onAllow}>
          {t("jarvis.consent.allow")}
        </button>
        <button type="button" className="btn btn--sm" onClick={onCancel}>
          {t("jarvis.consent.cancel")}
        </button>
      </div>
    </section>
  );
}

/** Under a question that went with an investigation's summary, or with
    Jarvis's memory and instructions: that it did, and the message as it
    went out, masked. */
export function SentContext({
  text,
  kind = "summary",
}: {
  text: string;
  /** What rode with the question: an investigation's summary, a skill's
      instructions, or only Jarvis's memory and instructions. */
  kind?: "summary" | "skill" | "personal";
}) {
  const { t, locale } = useT();
  const size = formatBytes(bytes(text), locale);
  return (
    <details className="asst-context-sent" data-testid="assistant-context-sent">
      <summary>
        {kind === "personal"
          ? t("jarvis.personal.sent", { size })
          : kind === "skill"
            ? t("skills.sent", { size })
            : t("jarvis.consent.sent", { size })}
      </summary>
      <pre>{text}</pre>
    </details>
  );
}
