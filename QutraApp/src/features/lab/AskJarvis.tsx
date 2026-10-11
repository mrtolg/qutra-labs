import { useState, type Ref } from "react";
import { Cloud, MessageSquare } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { Engagement } from "@/domain/lab";
import { revokeCloudConsent } from "@/lib/cloudConsent";
import { createConversation, openConversation } from "@/lib/db/conversations";
import { getDb } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { useT } from "@/lib/i18n";

/* Asking Jarvis about an investigation. The
   conversation is linked to the investigation; its first cloud question
   shows the consent card before the summary goes. */

/** "Jarvis'e sor": Jarvis, in a conversation linked to this investigation.
    An empty linked conversation is reused rather than adding another. */
export function AskJarvis({
  engagement,
  buttonRef,
}: {
  engagement: Engagement;
  /** The button, for the focus to land on after an allowance is revoked. */
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const ask = async () => {
    const db = getDb();
    const empty = db
      .collection("conversations")
      .getAll()
      .find(
        (c) =>
          c.engagementId === engagement.id && c.messages.length === 0 && c.archivedAt === undefined,
      );
    try {
      if (empty) await openConversation(db, empty.id);
      else await createConversation(db, { engagementId: engagement.id });
    } catch (caught) {
      console.error("conversation not opened", caught);
    }
    navigate("/jarvis");
  };
  return (
    <button ref={buttonRef} type="button" className="btn btn--secondary" onClick={() => void ask()}>
      <MessageSquare size={14} aria-hidden /> {t("lab.askJarvis")}
    </button>
  );
}

/** Takes an investigation's cloud allowance back. The revoke is a durable
    write; one that fails says so, since the allowance would still stand. One
    that succeeds is announced, and the button, now gone, hands the focus to
    `onRevoked`. */
export function RevokeCloudConsent({
  engagementId,
  label,
  onRevoked,
}: {
  engagementId: string;
  /** What the button takes back, for a screen reader. */
  label: string;
  /** Where the focus goes once the allowance, and so this button, is gone. */
  onRevoked?: () => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await revokeCloudConsent(engagementId);
      useUi.getState().announce(t("lab.cloudConsent.revoked"));
      onRevoked?.();
    } catch (caught) {
      console.error("cloud allowance not revoked", caught);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {/* aria-disabled, not disabled: a disabled button drops the focus. */}
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label={label}
        aria-disabled={busy || undefined}
        onClick={() => void revoke()}
      >
        {t("lab.cloudConsent.revoke")}
      </button>
      {failed && (
        <span className="form-error" role="alert">
          {t("lab.cloudConsent.revokeFailed")}
        </span>
      )}
    </>
  );
}

/** The investigation's cloud allowance, and the way to take it back. */
export function CloudConsentStat({
  engagement,
  onRevoked,
}: {
  engagement: Engagement;
  onRevoked?: () => void;
}) {
  const { t } = useT();
  const consent = engagement.cloudConsent;
  if (!consent) return null;
  return (
    <span className="lab-stat" data-testid="lab-cloud-consent">
      <Cloud size={13} aria-hidden /> {t("lab.cloudConsent.given", { host: consent.host })}
      <RevokeCloudConsent
        engagementId={engagement.id}
        label={t("lab.cloudConsent.revokeLabel", { host: consent.host })}
        onRevoked={onRevoked}
      />
    </span>
  );
}
