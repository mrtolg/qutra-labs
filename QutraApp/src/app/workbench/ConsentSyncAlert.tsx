import { useT } from "@/lib/i18n";
import { retryConsentSync, useConsentSync } from "./consentSync";

/** Stays until Retry succeeds: a Private Lab state the app could not confirm
    is never shown as if it had synced. */
export function ConsentSyncAlert() {
  const { t } = useT();
  const failure = useConsentSync((s) => s.failure);
  if (!failure) return null;
  return (
    <div
      className="callout callout--warning flex"
      role="alert"
      data-testid="consent-sync-error"
      style={{ gap: "var(--sp-3)", alignItems: "center", margin: "var(--sp-3)" }}
    >
      <span style={{ flex: 1 }}>
        {t(
          failure === "read"
            ? "privateLab.sync.readFailed"
            : "privateLab.sync.revokeFailed",
        )}
      </span>
      <button
        type="button"
        className="btn btn--sm"
        onClick={retryConsentSync}
        data-testid="consent-sync-retry"
      >
        {t("action.retry")}
      </button>
    </div>
  );
}
