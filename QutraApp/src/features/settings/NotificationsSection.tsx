import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { useUi } from "@/state/ui";
import { getBridge, isTauri } from "@/lib/bridge";

export function NotificationsSection() {
  const { t } = useT();
  const toast = useUi((s) => s.toast);

  return (
    <section className="settings-section">
      <p className="muted" style={{ fontSize: "var(--fs-13)", marginBottom: "var(--sp-3)" }}>
        {isTauri()
          ? t("settings.notif.quietHint")
          : t("settings.notif.osUnavailable")}
      </p>
      <div className="setting-row">
        <div className="setting-label">{t("settings.notif.test")}</div>
        <button
          type="button"
          className="btn btn--secondary"
          disabled={!isTauri()}
          onClick={() => {
            void (async () => {
              if (!isTauri()) {
                toast({ kind: "info", messageKey: "settings.notif.osUnavailable" });
                return;
              }
              const result = await getBridge().notify(
                t("app.name"),
                t("settings.notif.test"),
              );
              if (result.ok) {
                toast({ kind: "success", messageKey: "settings.notif.testOk" });
              } else {
                toast({ kind: "danger", messageKey: "settings.notif.testDenied" });
              }
            })();
          }}
        >
          {t("settings.notif.test")}
        </button>
      </div>
      {(
        [
          "settings.notif.sessionEnd",
          "settings.notif.automation",
          "settings.notif.restore",
        ] as MessageKey[]
      ).map((key) => (
        <div key={key} className="setting-row">
          <div>
            <div className="setting-label" id={`setting-${key}`}>
              {t(key)}
            </div>
            <div className="setting-hint">{t("settings.notif.quietHint")}</div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              aria-labelledby={`setting-${key}`}
              checked={false}
              disabled
              title={t("settings.notif.quietHint")}
            />
            <span className="switch-track" aria-hidden />
          </label>
        </div>
      ))}
    </section>
  );
}
