import { useT } from "@/lib/i18n";
import { getStorageKind, useCollection } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { getBridge, isTauri } from "@/lib/bridge";
import { APP_VERSION, REPO_URL } from "@/lib/appMeta";
import { BUILD_INFO, formatBuild } from "@/lib/buildInfo";
import { now, formatDateTime } from "@/lib/time";
import { diagnosticsText } from "./settingsDiagnostics";

export function AboutSection() {
  const { t, locale } = useT();
  const toast = useUi((s) => s.toast);
  const events = useCollection("events");

  const copyDiagnostics = async () => {
    const result = await getBridge().writeClipboard(diagnosticsText());
    toast({
      kind: result.ok ? "success" : "danger",
      messageKey: result.ok ? "toast.copied" : "error.dbBody",
    });
  };

  return (
    <section className="settings-section">
      <div className="flex" style={{ gap: 12, marginBottom: "var(--sp-4)" }}>
        <img
          className="brand-logo"
          src="/favicon.png"
          alt=""
          aria-hidden
          style={{ width: 36, height: 36, borderRadius: 8 }}
        />
        <div>
          <div style={{ fontWeight: 600, fontSize: "var(--fs-16)" }}>
            {t("app.name")}
          </div>
          <div className="muted" style={{ fontSize: "var(--fs-12)" }}>
            {t("settings.about.author")}
          </div>
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-label">{t("settings.about.version")}</div>
        <span className="mono" data-testid="about-version">
          {APP_VERSION} · {formatBuild(BUILD_INFO)}
        </span>
      </div>
      <div className="setting-row">
        <div className="setting-label">{t("settings.about.mode")}</div>
        <span>
          {isTauri()
            ? t("settings.about.modeDesktop")
            : t("settings.about.modeBrowser")}
        </span>
      </div>
      <div className="setting-row">
        <div className="setting-label">{t("settings.about.storage")}</div>
        <span className="mono">
          {getStorageKind() === "sqlite"
            ? "SQLite"
            : getStorageKind() === "memory"
              ? "in-memory"
              : "localStorage"}
        </span>
      </div>
      <div className="setting-row">
        <div className="setting-label">{t("settings.about.license")}</div>
        <span>MIT · © 2026 Mert Olgun</span>
      </div>
      <p className="muted" style={{ fontSize: "var(--fs-13)", marginTop: "var(--sp-2)" }}>
        {t("settings.about.privacy")}
      </p>
      <div className="flex" style={{ marginTop: "var(--sp-3)", gap: "var(--sp-2)" }}>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => void copyDiagnostics()}
        >
          {t("settings.about.copyDiag")}
        </button>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={!REPO_URL}
          title={REPO_URL ?? t("settings.about.repoUnset")}
          onClick={() => REPO_URL && getBridge().openUrl(REPO_URL)}
        >
          {REPO_URL ? t("settings.about.repo") : t("settings.about.repoUnset")}
        </button>
      </div>
      <p className="faint" style={{ fontSize: "var(--fs-12)", marginTop: "var(--sp-2)" }}>
        {events.length} {t("settings.activityLog").toLowerCase()} · {formatDateTime(now(), locale)}
      </p>
    </section>
  );
}
