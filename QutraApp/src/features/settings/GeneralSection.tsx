import { useT } from "@/lib/i18n";
import { getDb } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { loadDemoData, isSeeded } from "@/domain/seed";

export function GeneralSection() {
  const { t } = useT();
  const toast = useUi((s) => s.toast);
  const db = getDb();
  const seeded = isSeeded(db);

  return (
    <section className="settings-section">
      <div className="setting-row">
        <div>
          <div className="setting-label" id="setting-start-on-login">
            {t("settings.startOnLogin")}
          </div>
          <div className="setting-hint">{t("settings.startOnLoginHint")}</div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            aria-labelledby="setting-start-on-login"
            checked={false}
            disabled
            title={t("settings.startOnLoginUnavailable")}
            onChange={() => undefined}
          />
          <span className="switch-track" aria-hidden />
        </label>
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">
            {seeded ? t("action.removeDemo") : t("action.loadDemo")}
          </div>
        </div>
        {seeded ? (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              const removed = db.removeDemoData();
              toast({
                kind: "info",
                messageKey: "settings.demoRemoved",
                params: { count: removed },
              });
            }}
          >
            {t("action.removeDemo")}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              loadDemoData(db);
              toast({ kind: "success", messageKey: "settings.demoLoaded" });
            }}
          >
            {t("action.loadDemo")}
          </button>
        )}
      </div>
    </section>
  );
}
