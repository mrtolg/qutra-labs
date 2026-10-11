import { useState } from "react";
import { Check } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { getDb, usePreferences } from "@/lib/db/database";
import { PACKS } from "@/lib/appearance";
import { draftIsPending, draftToPrefs, useAppearanceDraft } from "@/lib/appearanceDraft";
import { useUi } from "@/state/ui";
import "./applyBar.css";

const MODE_LABEL: Record<string, MessageKey> = {
  system: "settings.theme.system",
  light: "settings.theme.light",
  dark: "settings.theme.dark",
  schedule: "themeStudio.schedule",
};

/**
 * The foot of the Settings dialog while an appearance is being tried: it
 * names the preview and holds Apply and Discard, so they stay in reach however
 * far the section scrolls. Apply stores the draft; the window keeps showing
 * it because the stored preferences now say the same.
 */
export function AppearanceApplyBar() {
  const { t } = useT();
  const prefs = usePreferences();
  const draft = useAppearanceDraft((s) => s.draft);
  const setDraft = useAppearanceDraft((s) => s.setDraft);
  const toast = useUi((s) => s.toast);
  const announce = useUi((s) => s.announce);
  const [saving, setSaving] = useState(false);

  if (!draft || !draftIsPending(draft, prefs)) return null;
  const pack = PACKS.find((p) => p.id === draft.packId);

  const apply = async () => {
    setSaving(true);
    try {
      await getDb().prefs.setDurable(draftToPrefs(draft));
      setDraft(null);
      announce(t("appearance.applied"));
    } catch {
      toast({ kind: "danger", messageKey: "settings.prefsSaveFailed" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="appearance-bar" role="region" aria-label={t("appearance.barLabel")}>
      <div className="appearance-bar__text">
        <span className="appearance-bar__title">
          {t("appearance.previewing", {
            pack: pack ? t(pack.nameKey) : draft.packId,
            mode: t(MODE_LABEL[draft.themeMode] ?? "settings.theme.system"),
          })}
        </span>
        <span className="appearance-bar__hint">{t("appearance.previewHint")}</span>
      </div>
      <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDraft(null)}>
        {t("appearance.discard")}
      </button>
      <button
        type="button"
        className="btn btn--primary btn--sm"
        disabled={saving}
        onClick={() => void apply()}
      >
        <Check size={14} aria-hidden /> {t("themeStudio.apply")}
      </button>
    </div>
  );
}
