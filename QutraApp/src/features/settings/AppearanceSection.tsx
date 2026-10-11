import { useT } from "@/lib/i18n";
import { getDb, usePreferences } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { Segmented } from "@/components/ui/Segmented";
import { ThemeStudio } from "./ThemeStudio";

export function AppearanceSection() {
  const { t } = useT();
  const toast = useUi((s) => s.toast);
  const prefs = usePreferences();
  const db = getDb();

  const savePrefs = async (changes: Parameters<typeof db.prefs.setDurable>[0]) => {
    try {
      await db.prefs.setDurable(changes);
    } catch {
      toast({ kind: "danger", messageKey: "settings.prefsSaveFailed" });
    }
  };

  return (
    <section className="settings-section">
      <div className="setting-row setting-row--block">
        <div className="setting-label">{t("themeStudio.title")}</div>
        <ThemeStudio />
      </div>
      <div className="setting-row">
        <div className="setting-label">{t("common.density")}</div>
        <Segmented
          ariaLabel={t("common.density")}
          value={prefs.density}
          onChange={(v) => void savePrefs({ density: v })}
          options={[
            { value: "comfortable", label: t("settings.density.comfortable") },
            { value: "compact", label: t("settings.density.compact") },
          ]}
        />
      </div>
      <div className="setting-row">
        <div className="setting-label" id="setting-reduce-motion">
          {t("settings.reduceMotion")}
        </div>
        <label className="switch">
          <input
            type="checkbox"
            aria-labelledby="setting-reduce-motion"
            checked={prefs.reduceMotion}
            onChange={(e) => void savePrefs({ reduceMotion: e.target.checked })}
          />
          <span className="switch-track" aria-hidden />
        </label>
      </div>
      <div className="setting-row">
        <div className="setting-label" id="setting-color-blind-charts">
          {t("settings.colorBlindCharts")}
        </div>
        <label className="switch">
          <input
            type="checkbox"
            aria-labelledby="setting-color-blind-charts"
            checked={prefs.colorBlindCharts}
            onChange={(e) => void savePrefs({ colorBlindCharts: e.target.checked })}
          />
          <span className="switch-track" aria-hidden />
        </label>
      </div>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() =>
          db.prefs.reset(["density", "reduceMotion", "colorBlindCharts"])
        }
      >
        {t("settings.resetSection")}
      </button>
    </section>
  );
}
