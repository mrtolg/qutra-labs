import { Square, Volume2 } from "lucide-react";
import type { Preferences } from "@/domain/types";
import { getDb, usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import { LOCALE_NAMES, resolveLocale } from "@/lib/i18n/locales";
import {
  MAX_RATE,
  MIN_RATE,
  pickVoice,
  speak,
  speechAvailable,
  stopSpeaking,
  voiceChoices,
} from "@/lib/voice/speech";
import { useSpeakingId, useVoices } from "@/lib/voice/useSpeech";

/* Settings › AI providers › Voice: whether answers are read aloud, with which
   of the voices Windows has installed, and how fast. The voice is saved by
   name; a name that is no longer installed is reported and the best voice for
   the language is used until the user picks again. */

const TRY_ID = "voice-try";
const AUTOMATIC = "";

export function VoiceSettings() {
  const { t } = useT();
  const prefs = usePreferences();
  const voices = useVoices();
  const trying = useSpeakingId() === TRY_ID;
  const locale = resolveLocale(prefs.locale);
  const language = LOCALE_NAMES[locale];
  const available = speechAvailable();
  const { matching, others } = voiceChoices(voices, locale);

  const saved = prefs.voiceName;
  const savedMissing = saved !== "" && voices.length > 0 && !voices.some((v) => v.name === saved);
  const best = pickVoice(voices, locale, AUTOMATIC);
  const used = pickVoice(voices, locale, saved);
  const optionOf = (v: SpeechSynthesisVoice) => (
    <option key={v.name} value={v.name}>
      {v.localService ? v.name : `${v.name} (${t("voice.onlineTag")})`}
    </option>
  );
  const usedOnline = used?.localService === false;
  const setPref = (change: Partial<Preferences>) => {
    // What is playing was started with the old choice.
    stopSpeaking();
    getDb().prefs.set(change);
  };

  return (
    <div className="voice-settings" data-testid="voice-settings">
      <h4 className="settings-block-heading">{t("voice.title")}</h4>
      <p className="muted settings-block-lede">{t("voice.lede")}</p>

      <div className="setting-row">
        <div>
          <div className="setting-label" id="setting-voice-read-aloud">
            {t("voice.readAloud")}
          </div>
          <div className="setting-hint">{t("voice.readAloudHint")}</div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            aria-labelledby="setting-voice-read-aloud"
            checked={prefs.voiceReadAloud}
            disabled={!available}
            onChange={(e) => setPref({ voiceReadAloud: e.target.checked })}
          />
          <span className="switch-track" aria-hidden />
        </label>
      </div>

      {!available ? (
        <p className="muted voice-settings__note" data-testid="voice-unavailable">
          {t("voice.unavailable")}
        </p>
      ) : voices.length === 0 ? (
        <p className="muted voice-settings__note" data-testid="voice-none">
          {t("voice.none")}
        </p>
      ) : (
        <>
          <div className="setting-row">
            <label className="setting-label" htmlFor="setting-voice-name">
              {t("voice.voice")}
            </label>
            <select
              id="setting-voice-name"
              className="select"
              value={savedMissing ? AUTOMATIC : saved}
              onChange={(e) => setPref({ voiceName: e.target.value })}
              data-testid="voice-picker"
            >
              <option value={AUTOMATIC}>
                {best ? t("voice.auto", { name: best.name }) : t("voice.autoNone")}
              </option>
              {matching.length > 0 && (
                <optgroup label={t("voice.groupMatching", { language })}>
                  {matching.map(optionOf)}
                </optgroup>
              )}
              {others.length > 0 && (
                <optgroup label={t("voice.groupOthers")}>
                  {others.map(optionOf)}
                </optgroup>
              )}
            </select>
          </div>
          {matching.length === 0 && (
            <p className="muted voice-settings__note" data-testid="voice-no-match">
              {t("voice.noMatch", { language })}
            </p>
          )}
          {savedMissing && (
            <p className="muted voice-settings__note" data-testid="voice-saved-missing">
              {t("voice.savedMissing", {
                name: saved,
                used: used?.name ?? t("voice.systemDefault"),
              })}
            </p>
          )}

          {usedOnline && (
            <p className="muted voice-settings__note" data-testid="voice-online-note">
              {t("voice.onlineNote")}
            </p>
          )}

          <div className="setting-row">
            <label className="setting-label" htmlFor="setting-voice-rate">
              {t("voice.rate")}
            </label>
            <span className="voice-settings__rate">
              <input
                id="setting-voice-rate"
                type="range"
                min={MIN_RATE}
                max={MAX_RATE}
                step={0.1}
                value={prefs.voiceRate}
                aria-valuetext={t("voice.rateValue", { rate: prefs.voiceRate.toFixed(1) })}
                onChange={(e) => setPref({ voiceRate: Number(e.target.value) })}
              />
              <output htmlFor="setting-voice-rate">
                {t("voice.rateValue", { rate: prefs.voiceRate.toFixed(1) })}
              </output>
            </span>
          </div>

          <div className="setting-row">
            <div className="setting-hint">{t("voice.sampleHint")}</div>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="voice-try"
              onClick={() =>
                trying ? stopSpeaking() : speak(t("voice.sample"), { id: TRY_ID, locale })
              }
            >
              {trying ? <Square size={13} aria-hidden /> : <Volume2 size={13} aria-hidden />}{" "}
              {trying ? t("voice.tryStop") : t("voice.try")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
