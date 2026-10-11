import { getDb, usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";

/** Settings › Advanced: whether a newly registered tool's official logo is
    fetched. Off, nothing is fetched and new tools keep their letter tile. */
export function ToolLogoSetting() {
  const { t } = useT();
  const prefs = usePreferences();
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label" id="setting-tool-logo-fetch">
          {t("settings.toolLogos.label")}
        </div>
        <div className="setting-hint">{t("settings.toolLogos.hint")}</div>
      </div>
      <label className="switch">
        <input
          type="checkbox"
          aria-labelledby="setting-tool-logo-fetch"
          checked={prefs.toolLogoFetch}
          onChange={(event) => getDb().prefs.set({ toolLogoFetch: event.target.checked })}
          data-testid="tool-logo-fetch"
        />
        <span className="switch-track" aria-hidden />
      </label>
    </div>
  );
}
