import { useEffect, useMemo, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { useT, SUPPORTED_LOCALES, LOCALE_NAMES, type Locale } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { getDb, usePreferences } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import type { Preferences } from "@/domain/types";
import {
  DEFAULT_REGIONAL_FORMAT,
  systemTimeZone,
  type DateFormat,
  type HourCycle,
  type NumberFormat,
  type RegionalFormat,
} from "@/lib/regionalFormat";
import { formatDate, formatDateTime, formatNumber, formatRelative, formatTime, now } from "@/lib/time";
import "./settingsSections.css";

/** One sentence in each language, written in that language: data, so it
    is not translated with the catalogs. */
const LOCALE_SAMPLES: Record<Locale, string> = {
  en: "Your investigation is ready: 3 findings, 2 scans.",
  tr: "İncelemeniz hazır: 3 bulgu, 2 tarama.",
  de: "Ihre Untersuchung ist bereit: 3 Befunde, 2 Scans.",
  es: "Su investigación está lista: 3 hallazgos, 2 análisis.",
  fr: "Votre enquête est prête : 3 constats, 2 analyses.",
  it: "La sua indagine è pronta: 3 risultati, 2 scansioni.",
};

const DATE_FORMATS: readonly DateFormat[] = ["auto", "dmy", "mdy", "ymd"];
const HOUR_CYCLES: readonly HourCycle[] = ["auto", "h23", "h12"];
const NUMBER_FORMATS: readonly NumberFormat[] = ["auto", "dot", "comma", "space"];
const SAMPLE_NUMBER = 1234567.89;

/** Every zone the platform knows, with the computer's own first. */
function listTimeZones(): string[] {
  try {
    const all = Intl.supportedValuesOf("timeZone");
    return all.includes("UTC") ? all : ["UTC", ...all];
  } catch {
    return ["UTC", "Europe/Istanbul", "Europe/London", "Europe/Berlin", "America/New_York"];
  }
}

function zoneOffset(zone: string, at: number, locale: string): string {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? "";
  } catch {
    return "";
  }
}

function regionalOf(prefs: Preferences): RegionalFormat {
  return {
    dateFormat: prefs.dateFormat,
    hourCycle: prefs.hourCycle,
    numberFormat: prefs.numberFormat,
    timeZone: prefs.timeZone,
  };
}

/**
 * Settings › Language & region: the language list in each language's own
 * name with a sentence in it, the date, time, number and time-zone formats
 * each with its example, and a live preview of how the app shows them.
 * Every change is written to disk before the page says it is saved.
 */
export function LanguageRegionSection() {
  const { t, locale } = useT();
  const prefs = usePreferences();
  const toast = useUi((s) => s.toast);
  const announce = useUi((s) => s.announce);
  const [clock, setClock] = useState(now);
  const zones = useMemo(listTimeZones, []);
  const systemZone = useMemo(systemTimeZone, []);
  const current = regionalOf(prefs);

  // The examples show the time now; a minute is the finest step they show.
  useEffect(() => {
    const id = window.setInterval(() => setClock(now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const languageName = useMemo(() => {
    try {
      const names = new Intl.DisplayNames([locale], { type: "language" });
      return (code: Locale) => names.of(code) ?? code;
    } catch {
      return (code: Locale) => code;
    }
  }, [locale]);

  const save = async (changes: Partial<Preferences>, said: () => string) => {
    try {
      await getDb().prefs.setDurable(changes);
      announce(said());
      return true;
    } catch {
      toast({ kind: "danger", messageKey: "settings.prefsSaveFailed" });
      return false;
    }
  };

  const chooseLanguage = async (code: Locale) => {
    if (code === prefs.locale) return;
    const saved = await save({ locale: code }, () =>
      t("settings.region.languageSaved", { name: LOCALE_NAMES[code] }),
    );
    if (saved) {
      toast({
        kind: "success",
        messageKey: "settings.region.languageSaved",
        params: { name: LOCALE_NAMES[code] },
      });
    }
  };

  const chooseFormat = (changes: Partial<RegionalFormat>) => {
    const next = { ...current, ...changes };
    void save(changes, () =>
      t("settings.region.saved", {
        example: `${formatDate(clock, locale, next)} ${formatTime(clock, locale, next)}`,
      }),
    );
  };

  const isDefault =
    current.dateFormat === DEFAULT_REGIONAL_FORMAT.dateFormat &&
    current.hourCycle === DEFAULT_REGIONAL_FORMAT.hourCycle &&
    current.numberFormat === DEFAULT_REGIONAL_FORMAT.numberFormat &&
    current.timeZone === DEFAULT_REGIONAL_FORMAT.timeZone;

  const resetFormats = async () => {
    const saved = await save({ ...DEFAULT_REGIONAL_FORMAT }, () => t("settings.region.resetDone"));
    if (saved) toast({ kind: "success", messageKey: "settings.region.resetDone" });
  };

  const withFormat = (changes: Partial<RegionalFormat>): RegionalFormat => ({
    ...current,
    ...changes,
  });
  const byLanguage = (example: string) => t("settings.region.byLanguage", { example });
  const zoneName = current.timeZone === "system" ? systemZone : current.timeZone;

  return (
    <section className="settings-section settings-section--wide region-page">
      <div className="region-layout">
        <div className="region-controls">
          <div className="region-block">
            <h4 className="settings-block-heading" id="region-language-label">
              {t("settings.region.languageHeading")}
            </h4>
            <p className="muted settings-block-lede">{t("settings.region.languageLede")}</p>
            <div className="lang-list" role="radiogroup" aria-labelledby="region-language-label">
              {SUPPORTED_LOCALES.map((code) => {
                const selected = prefs.locale === code;
                return (
                  <label key={code} className={`lang-row${selected ? " is-selected" : ""}`}>
                    <input
                      type="radio"
                      className="sr-only"
                      name="app-language"
                      value={code}
                      checked={selected}
                      onChange={() => void chooseLanguage(code)}
                    />
                    <span className="lang-row__name" lang={code}>
                      {LOCALE_NAMES[code]}
                    </span>
                    <span className="lang-row__local">{languageName(code)}</span>
                    <span className="lang-row__sample" lang={code}>
                      {LOCALE_SAMPLES[code]}
                    </span>
                    <span className="lang-row__mark" aria-hidden>
                      {selected && <Check size={15} />}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="region-block">
            <h4 className="settings-block-heading">{t("settings.region.formatsHeading")}</h4>
            <p className="muted settings-block-lede">{t("settings.region.formatsLede")}</p>
            <div className="format-list">
              <FormatRow
                id="region-date"
                label={t("settings.region.date")}
                value={current.dateFormat}
                example={formatDate(clock, locale, current)}
                options={DATE_FORMATS.map((value) => {
                  const example = formatDate(clock, locale, withFormat({ dateFormat: value }));
                  return { value, label: value === "auto" ? byLanguage(example) : example };
                })}
                onChange={(value) => chooseFormat({ dateFormat: value as DateFormat })}
              />
              <FormatRow
                id="region-time"
                label={t("settings.region.time")}
                value={current.hourCycle}
                example={formatTime(clock, locale, current)}
                options={HOUR_CYCLES.map((value) => {
                  const example = formatTime(clock, locale, withFormat({ hourCycle: value }));
                  return {
                    value,
                    label:
                      value === "auto"
                        ? byLanguage(example)
                        : t(`settings.region.${value}` as MessageKey, { example }),
                  };
                })}
                onChange={(value) => chooseFormat({ hourCycle: value as HourCycle })}
              />
              <FormatRow
                id="region-number"
                label={t("settings.region.number")}
                value={current.numberFormat}
                example={formatNumber(SAMPLE_NUMBER, locale, undefined, current)}
                options={NUMBER_FORMATS.map((value) => {
                  const example = formatNumber(
                    SAMPLE_NUMBER,
                    locale,
                    undefined,
                    withFormat({ numberFormat: value }),
                  );
                  return { value, label: value === "auto" ? byLanguage(example) : example };
                })}
                onChange={(value) => chooseFormat({ numberFormat: value as NumberFormat })}
              />
              <FormatRow
                id="region-zone"
                label={t("settings.region.zone")}
                value={zones.includes(current.timeZone) ? current.timeZone : "system"}
                example={`${formatTime(clock, locale, current)} · ${zoneOffset(zoneName, clock, locale)}`}
                options={[
                  {
                    value: "system",
                    label: t("settings.region.zoneSystem", { zone: systemZone }),
                  },
                  ...zones.map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") })),
                ]}
                onChange={(value) => chooseFormat({ timeZone: value })}
              />
            </div>
            {!isDefault && (
              <button
                type="button"
                className="btn btn--ghost btn--sm region-reset"
                onClick={() => void resetFormats()}
              >
                <RotateCcw size={13} aria-hidden /> {t("settings.region.reset")}
              </button>
            )}
          </div>
        </div>

        <aside className="region-specimen" aria-labelledby="region-preview-title">
          <div className="region-specimen__head">
            <h4 className="region-specimen__title" id="region-preview-title">
              {t("settings.region.preview")}
            </h4>
            <span className="faint region-specimen__lede">{t("settings.region.previewLede")}</span>
          </div>
          <div className="region-specimen__clock" data-testid="region-preview-clock">
            {formatTime(clock, locale, current)}
          </div>
          <div className="region-specimen__date">{formatDate(clock, locale, current)}</div>
          <dl className="region-specimen__rows" data-testid="region-preview">
            <dt>{t("settings.region.previewOpened")}</dt>
            <dd>{formatDateTime(clock - 2 * 86_400_000 - 3_600_000, locale, current)}</dd>
            <dt>{t("settings.region.previewLastScan")}</dt>
            <dd>{formatRelative(clock - 3 * 60_000, locale)}</dd>
            <dt>{t("settings.region.previewFindings")}</dt>
            <dd>{formatNumber(1234, locale, undefined, current)}</dd>
            <dt>{t("settings.region.previewSize")}</dt>
            <dd>{formatNumber(12.5, locale, { maximumFractionDigits: 1 }, current)} MB</dd>
            <dt>{t("settings.region.zone")}</dt>
            <dd>
              {zoneName.replaceAll("_", " ")} · {zoneOffset(zoneName, clock, locale)}
            </dd>
          </dl>
          <p className="faint region-specimen__foot">{t("settings.region.persisted")}</p>
        </aside>
      </div>
    </section>
  );
}

function FormatRow({
  id,
  label,
  value,
  example,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  example: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const { t } = useT();
  return (
    <div className="format-row">
      <label className="format-row__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="select format-row__select"
        value={value}
        aria-describedby={`${id}-example`}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="format-row__example" id={`${id}-example`}>
        <span className="sr-only">{t("settings.region.example")}: </span>
        <span className="mono">{example}</span>
      </span>
    </div>
  );
}
