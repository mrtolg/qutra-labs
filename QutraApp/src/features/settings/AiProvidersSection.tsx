import { ShieldCheck } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import { JarvisRoutePicker } from "./JarvisRoutePicker";
import { LocalAssistantSettings } from "./LocalAssistantSettings";
import { CloudConnections } from "./CloudConnections";
import { CloudConsents } from "./CloudConsents";
import "./settingsSections.css";

/** Settings › AI providers: which way Jarvis talks, the local model, the
    cloud connections, the investigations allowed to go to the cloud, and
    the masking that applies to all of it. */
export function AiProvidersSection() {
  const { t } = useT();
  const openSettings = useUi((s) => s.openSettings);
  return (
    <section className="settings-section settings-section--wide ai-section">
      <JarvisRoutePicker />

      <div className="ai-section__block">
        <h4 className="settings-block-heading">{t("settings.ai.localTitle")}</h4>
        {/* Its own component: the on-demand local engine replaces it later. */}
        <LocalAssistantSettings />
      </div>

      <div className="ai-section__block">
        <h4 className="settings-block-heading">{t("settings.cloud.title")}</h4>
        <p className="muted settings-block-lede">{t("settings.cloud.lede")}</p>
        <CloudConnections />
      </div>

      <div className="ai-section__block">
        <CloudConsents />
      </div>

      <p className="mask-line">
        <ShieldCheck size={15} aria-hidden className="mask-line__icon" />
        <span>{t("settings.ai.maskLine")}</span>
        <button
          type="button"
          className="btn btn--ghost btn--sm mask-line__link"
          onClick={() => openSettings("privacy")}
        >
          {t("settings.ai.maskLink")}
        </button>
      </p>
    </section>
  );
}
