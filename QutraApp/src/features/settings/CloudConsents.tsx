import { useRef } from "react";
import { FileLock2 } from "lucide-react";
import { RevokeCloudConsent } from "@/features/lab/AskJarvis";
import { useCollection } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import { formatDate } from "@/lib/time";

/** Investigations whose summary may go to a cloud connection,
    each with the way to take the allowance back. */
export function CloudConsents() {
  const { t, locale } = useT();
  const allowed = useCollection("engagements").filter((e) => e.cloudConsent);
  /** A revoked row goes away with its button; the focus lands here. */
  const labelRef = useRef<HTMLHeadingElement | null>(null);
  return (
    <div className="settings-cloud-consents" data-testid="settings-cloud-consents">
      <h4 className="settings-block-heading" ref={labelRef} tabIndex={-1}>
        {t("settings.cloud.consents")}
      </h4>
      <p className="muted settings-block-lede">{t("settings.cloud.consentsLede")}</p>
      {allowed.length === 0 ? (
        <p className="settings-empty-line">{t("settings.cloud.consentsNone")}</p>
      ) : (
        <ul className="consent-list">
          {allowed.map((engagement) => (
            <li key={engagement.id} className="consent-list__row">
              <FileLock2 size={15} className="consent-list__icon" aria-hidden />
              <div className="consent-list__text">
                <span className="consent-list__title">{engagement.title}</span>
                <span className="muted consent-list__meta">
                  {t("settings.cloud.consentTo", {
                    host: engagement.cloudConsent!.host,
                    date: formatDate(engagement.cloudConsent!.grantedAt, locale),
                  })}
                </span>
              </div>
              <RevokeCloudConsent
                engagementId={engagement.id}
                label={`${t("lab.cloudConsent.revoke")}: ${engagement.title}`}
                onRevoked={() => labelRef.current?.focus()}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
