import { useId } from "react";
import { usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import { HIDE_KEY_NAME } from "./guides";
import { setCompanionEnabled, showCompanionOn } from "./preferences";

/** Settings › General: the switch, and the pages the bubble was hidden on,
    each with a way to bring it back. */
export function CompanionSettings() {
  const { t } = useT();
  const prefs = usePreferences();
  const labelId = useId();
  return (
    <div className="setting-row" data-testid="companion-settings">
      <div>
        <div className="setting-label" id={labelId}>
          {t("companion.follow")}
        </div>
        <div className="setting-hint">{t("companion.followHint")}</div>
        {prefs.companionEnabled && (
          <div className="setting-hint">
            <span>{t("companion.hiddenPages")}: </span>
            {prefs.companionHidden.length === 0 ? (
              <span>{t("companion.hiddenNone")}</span>
            ) : (
              prefs.companionHidden.map((key) => {
                const name = HIDE_KEY_NAME[key];
                return (
                  <button
                    key={key}
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => showCompanionOn(key)}
                  >
                    {t("companion.showOn", { page: name ? t(name) : key })}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
      <label className="switch">
        <input
          type="checkbox"
          aria-labelledby={labelId}
          checked={prefs.companionEnabled}
          onChange={(event) => setCompanionEnabled(event.target.checked)}
        />
        <span className="switch-track" aria-hidden />
      </label>
    </div>
  );
}
