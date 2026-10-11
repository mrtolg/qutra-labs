import { useEffect, useId, useRef, useState } from "react";
import { Check, Download, RotateCcw, Upload } from "lucide-react";
import { z } from "zod";
import { useT } from "@/lib/i18n";
import { getDb, usePreferences } from "@/lib/db/database";
import { PACKS, resolveMode, themeAttrForPack, type PackId } from "@/lib/appearance";
import {
  DEFAULT_APPEARANCE,
  draftFromPrefs,
  draftIsPending,
  sameAppearance,
  useAppearanceDraft,
  type AppearanceDraft,
} from "@/lib/appearanceDraft";
import type { ThemeMode } from "@/lib/theme";
import { Segmented } from "@/components/ui/Segmented";
import { useUi } from "@/state/ui";
import "./appearance.css";

/** An appearance file. Older files may carry a window `material`; it is read and ignored. */
const AppearanceConfigSchema = z.object({
  app: z.literal("contextos-appearance"),
  schemaVersion: z.number().int().default(2),
  packId: z.enum(["hud", "contextos", "catppuccin", "highContrast"]),
  themeMode: z.enum(["light", "dark", "system", "schedule"]).default("system"),
  themeScheduleLightAt: z.string().default("07:00"),
  themeScheduleDarkAt: z.string().default("19:00"),
});

/**
 * Settings › Appearance: choose a colour pack and a light/dark mode. Every
 * choice is a draft the whole window previews at once; the Apply bar at the
 * foot of Settings stores it. Leaving Appearance or closing Settings drops an
 * unapplied draft and says so.
 */
export function ThemeStudio() {
  const { t } = useT();
  const prefs = usePreferences();
  const toast = useUi((s) => s.toast);
  const draft = useAppearanceDraft((s) => s.draft);
  const setDraft = useAppearanceDraft((s) => s.setDraft);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const stored = draftFromPrefs(prefs);
  const shown = draft ?? stored;
  const update = (changes: Partial<AppearanceDraft>) => setDraft({ ...shown, ...changes });
  const mode = resolveMode(
    { themeMode: shown.themeMode, themeScheduleLightAt: shown.themeScheduleLightAt, themeScheduleDarkAt: shown.themeScheduleDarkAt },
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  // Read the stored preferences when leaving, not the ones from when Appearance opened.
  useEffect(
    () => () => {
      const { draft: left, setDraft: clear } = useAppearanceDraft.getState();
      if (draftIsPending(left, getDb().prefs.get())) {
        toast({ kind: "info", messageKey: "appearance.draftDropped" });
      }
      clear(null);
    },
    [toast],
  );

  // One tab stop for the group; the arrow keys choose, as in any radio group.
  const movePack = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
    if (!step) return;
    e.preventDefault();
    const at = PACKS.findIndex((p) => p.id === shown.packId);
    const next = PACKS[(at + step + PACKS.length) % PACKS.length];
    update({ packId: next.id });
    e.currentTarget.parentElement
      ?.querySelector<HTMLElement>(`[data-pack-id="${next.id}"]`)
      ?.focus();
  };

  const exportAppearance = () => {
    const doc = { app: "contextos-appearance" as const, schemaVersion: 2 as const, ...shown };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "qutra-labs-appearance.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importAppearance = async (file: File) => {
    setImportError(null);
    try {
      const parsed = AppearanceConfigSchema.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) {
        setImportError(t("themeStudio.importError"));
        return;
      }
      const { packId, themeMode, themeScheduleLightAt, themeScheduleDarkAt } = parsed.data;
      setDraft({ packId, themeMode, themeScheduleLightAt, themeScheduleDarkAt });
    } catch {
      setImportError(t("themeStudio.importError"));
    }
  };

  return (
    <div className="appearance">
      <div role="radiogroup" aria-label={t("appearance.pack")} className="appearance-packs">
        {PACKS.map((meta) => (
          <PackCard
            key={meta.id}
            packId={meta.id}
            mode={mode}
            name={t(meta.nameKey)}
            desc={t(meta.descKey)}
            selected={shown.packId === meta.id}
            inUse={stored.packId === meta.id}
            inUseLabel={t("appearance.inUse")}
            onSelect={() => update({ packId: meta.id })}
            onKeyDown={movePack}
          />
        ))}
      </div>

      <div className="appearance-mode">
        <div className="appearance-mode__label">
          <span className="setting-label">{t("themeStudio.mode")}</span>
          {shown.packId === "hud" && mode === "light" && (
            <span className="setting-hint">{t("appearance.hudLightHint")}</span>
          )}
        </div>
        <Segmented
          ariaLabel={t("themeStudio.mode")}
          value={shown.themeMode}
          onChange={(v) => update({ themeMode: v as ThemeMode })}
          options={[
            { value: "system", label: t("settings.theme.system") },
            { value: "light", label: t("settings.theme.light") },
            { value: "dark", label: t("settings.theme.dark") },
            { value: "schedule", label: t("themeStudio.schedule") },
          ]}
        />
      </div>

      {shown.themeMode === "schedule" && (
        <div className="appearance-schedule">
          <label>
            {t("themeStudio.lightAt")}
            <input
              type="time"
              className="input"
              value={shown.themeScheduleLightAt}
              onChange={(e) => update({ themeScheduleLightAt: e.target.value })}
            />
          </label>
          <label>
            {t("themeStudio.darkAt")}
            <input
              type="time"
              className="input"
              value={shown.themeScheduleDarkAt}
              onChange={(e) => update({ themeScheduleDarkAt: e.target.value })}
            />
          </label>
        </div>
      )}

      <div className="appearance-files">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={sameAppearance(shown, DEFAULT_APPEARANCE)}
          onClick={() => update(DEFAULT_APPEARANCE)}
        >
          <RotateCcw size={13} aria-hidden /> {t("appearance.useDefaults")}
        </button>
        <span className="appearance-files__sep" aria-hidden />
        <button type="button" className="btn btn--ghost btn--sm" onClick={exportAppearance}>
          <Download size={13} aria-hidden /> {t("appearance.exportConfig")}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => fileRef.current?.click()}>
          <Upload size={13} aria-hidden /> {t("appearance.importConfig")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          aria-label={t("appearance.importConfig")}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importAppearance(f);
            e.target.value = "";
          }}
        />
      </div>
      {importError && (
        <p className="form-error" role="alert">
          {importError}
        </p>
      )}
    </div>
  );
}

/** One colour pack, drawn as a small Qutra Labs window in the pack's own tokens. */
function PackCard({
  packId,
  mode,
  name,
  desc,
  selected,
  inUse,
  inUseLabel,
  onSelect,
  onKeyDown,
}: {
  packId: PackId;
  mode: "light" | "dark";
  name: string;
  desc: string;
  selected: boolean;
  inUse: boolean;
  inUseLabel: string;
  onSelect: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const id = useId();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-desc`}
      tabIndex={selected ? 0 : -1}
      data-pack-id={packId}
      className="pack-card"
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span
        className="pack-window"
        data-theme={themeAttrForPack(packId)}
        data-pack={packId}
        data-mode={mode}
        aria-hidden
      >
        <span className="pack-window__bar">
          <span className="pack-window__mark" />
          <span className="pack-window__tab is-on" />
          <span className="pack-window__tab" />
          <span className="pack-window__tab" />
        </span>
        <span className="pack-window__body">
          <span className="pack-window__card">
            <span className="pack-window__line" />
            <span className="pack-window__line is-short" />
          </span>
          <span className="pack-window__actions">
            <span className="pack-window__btn">Aa</span>
            <span className="pack-window__chip" />
          </span>
        </span>
      </span>
      <span className="pack-card__meta">
        <span className="pack-card__name">
          <span id={`${id}-name`}>{name}</span>
          {inUse && <span className="pack-card__tag">{inUseLabel}</span>}
          {selected && <Check size={14} aria-hidden className="pack-card__check" />}
        </span>
        <span className="pack-card__desc" id={`${id}-desc`}>
          {desc}
        </span>
      </span>
    </button>
  );
}
