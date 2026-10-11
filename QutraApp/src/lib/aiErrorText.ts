import type { AiError } from "@/lib/aiConnections";
import type { useT } from "@/lib/i18n";

type Translate = ReturnType<typeof useT>["t"];

/** Why a call to a cloud service did not work, in plain words (Settings
    and Jarvis say the same thing for the same failure). */
export function aiErrorText(t: Translate, error: AiError): string {
  switch (error.code) {
    case "no_key":
      return t("settings.cloud.error.noKey");
    case "key_unreadable":
      return t("settings.cloud.error.keyUnreadable");
    case "address_not_found":
      return t("settings.cloud.error.addressNotFound");
    case "key_invalid":
      return t("settings.cloud.error.keyInvalid");
    case "billing":
      return t("settings.cloud.error.billing");
    case "no_access":
      return t("settings.cloud.error.noAccess");
    case "too_large":
      return t("settings.cloud.error.tooLarge");
    case "rate_limited":
      return error.retryAfterSeconds
        ? t("settings.cloud.error.rateLimited", { seconds: error.retryAfterSeconds })
        : t("settings.cloud.error.rateLimitedSoon");
    case "busy":
      return t("settings.cloud.error.busy");
    case "offline":
      return t("settings.cloud.error.offline");
    case "bad_request":
      return t("settings.cloud.error.badRequest", { status: error.status ?? 400 });
    default:
      return t("settings.cloud.error.unexpected");
  }
}
