import { useT } from "@/lib/i18n";
import { getDb, usePreferences } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { recordEvent } from "@/services/appService";

export function CaptureSection() {
  const { t } = useT();
  const toast = useUi((s) => s.toast);
  const prefs = usePreferences();
  const db = getDb();

  return (
    <section className="settings-section">
      <div className="setting-row">
        <div>
          <div className="setting-label" id="setting-activity">
            {prefs.activityTrackingEnabled
              ? t("privacy.activityOn")
              : t("privacy.activityOff")}
          </div>
          <div className="setting-hint">{t("settings.about.privacy")}</div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            aria-labelledby="setting-activity"
            checked={prefs.activityTrackingEnabled}
            onChange={(e) => {
              const enabled = e.target.checked;
              void db.prefs
                .setDurable({ activityTrackingEnabled: enabled })
                .then(() => {
                  recordEvent(
                    enabled ? "privacy_resumed" : "privacy_paused",
                    enabled
                      ? "Activity tracking enabled"
                      : "Activity tracking disabled",
                  );
                })
                .catch(() => {
                  toast({ kind: "danger", messageKey: "error.dbBody" });
                });
            }}
          />
          <span className="switch-track" aria-hidden />
        </label>
      </div>
    </section>
  );
}
