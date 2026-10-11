import { useT } from "@/lib/i18n";
import { getDb } from "@/lib/db/database";
import { isTauri } from "@/lib/bridge";
import { CURRENT_SCHEMA_VERSION } from "@/lib/db/migrations";

export function StorageSection() {
  const { t } = useT();
  const db = getDb();
  const dbSize = db.estimateSizeBytes();
  // Records this version could not read, kept instead of deleted.
  const quarantinedCount = db.quarantined().length;

  return (
    <section className="settings-section">
      <div className="setting-row">
        <div className="setting-label">{t("settings.dbSize")}</div>
        <span className="mono">{(dbSize / 1024).toFixed(1)} KB</span>
      </div>
      <div className="setting-row">
        <div className="setting-label">{t("settings.storagePath")}</div>
        <span className="mono" style={{ fontSize: "var(--fs-12)" }}>
          {isTauri() ? "%APPDATA%\\contextos\\contextos.db" : "localStorage (browser demo)"}
        </span>
      </div>
      <div className="setting-row">
        <div className="setting-label">{t("settings.migration")}</div>
        <span className="mono">v{CURRENT_SCHEMA_VERSION}</span>
      </div>
      {quarantinedCount > 0 && (
        <div className="setting-row">
          <div>
            <div className="setting-label">{t("settings.quarantine")}</div>
            <div className="setting-hint">{t("settings.quarantineHint")}</div>
          </div>
          <span className="mono">{quarantinedCount}</span>
        </div>
      )}
    </section>
  );
}
