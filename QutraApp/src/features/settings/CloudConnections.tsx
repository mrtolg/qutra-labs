import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, Cloud, KeyRound, Loader2, PlugZap, Trash2 } from "lucide-react";
import { Field } from "@/components/ui/Field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  aiConnections,
  DEFAULT_ANTHROPIC_MODEL,
  isAiError,
  OPENAI_PRESETS,
  targetKey,
  type AiError,
  type AiTarget,
  type ModelInfo,
  type OpenAiPreset,
} from "@/lib/aiConnections";
import { aiErrorText } from "@/lib/aiErrorText";
import { getDb, usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { useUi } from "@/state/ui";
import { refreshKeyStatuses, useKeyStatus } from "./cloudKeyStatus";

/**
 * Cloud connections for Jarvis (spec 2026-10-07 §7): Claude and
 * one OpenAI-compatible service. A key goes to Rust and never comes back:
 * the card says only that one is saved and shows its last four characters.
 * Testing a connection lists its models; the model the user picks is kept
 * in preferences for when Jarvis talks through it. Which
 * connection Jarvis uses is chosen in `JarvisRoutePicker`, or with the
 * card's own "Use for Jarvis" button.
 */
export function CloudConnections() {
  const { t } = useT();
  const prefs = usePreferences();

  if (!aiConnections.available()) {
    return (
      <div className="cloud-connections">
        <p className="muted cloud-connections__note">{t("settings.cloud.desktopOnly")}</p>
      </div>
    );
  }

  return (
    <div className="cloud-connections">
      <ConnectionCard title={t("settings.cloud.anthropicName")} />
      {/* Another service is another key, model list and test: a new card,
          so nothing of the previous one (an answer still on its way
          included) can land on it. */}
      <ConnectionCard
        key={prefs.aiOpenAiPreset}
        preset={prefs.aiOpenAiPreset}
        title={t("settings.cloud.compatName")}
        hint={t("settings.cloud.compatHint")}
      />
      <p className="faint cloud-connections__note">
        <KeyRound size={12} aria-hidden /> {t("settings.cloud.keysNote")}
      </p>
    </div>
  );
}

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; models: ModelInfo[] }
  | { kind: "error"; error: AiError };

/** One connection: Claude when `preset` is absent, else that OpenAI-compatible service. */
function ConnectionCard({
  preset,
  title,
  hint,
}: {
  preset?: OpenAiPreset;
  title: string;
  hint?: string;
}) {
  const { t } = useT();
  const prefs = usePreferences();
  const toast = useUi((s) => s.toast);
  const announce = useUi((s) => s.announce);
  const target = useMemo<AiTarget>(
    () => (preset ? { provider: "openai_compat", preset } : { provider: "anthropic" }),
    [preset],
  );
  const key = targetKey(target);
  const custom = preset === "custom";
  const idBase = `cloud-${key.replace(/[^a-z0-9]/gi, "-")}`;
  const route = target.provider;
  const inUse = prefs.aiProvider === route;

  const status = useKeyStatus(target);
  const [editing, setEditing] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftAddress, setDraftAddress] = useState("");
  const [saveError, setSaveError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  /* A button the keyboard was on can disappear (Change opens the form, Save
     and Remove close it): focus moves to what replaced it. */
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const testRef = useRef<HTMLButtonElement>(null);
  const [focusNext, setFocusNext] = useState<"field" | "test" | null>(null);

  const showForm = status !== null && (!status.present || editing);
  const showTest = status !== null && status.present && !editing;

  useEffect(() => {
    if (focusNext === "field" && showForm) {
      firstFieldRef.current?.focus();
      setFocusNext(null);
    } else if (focusNext === "test" && showTest) {
      testRef.current?.focus();
      setFocusNext(null);
    }
  }, [focusNext, showForm, showTest]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      await aiConnections.setKey(target, draftKey.trim(), custom ? draftAddress.trim() : null);
      // The key leaves the page's state as soon as Rust has it.
      setDraftKey("");
      setDraftAddress("");
      setEditing(false);
      setTest({ kind: "idle" });
      toast({ kind: "success", messageKey: "settings.cloud.savedToast" });
      refreshKeyStatuses();
      setFocusNext("test");
    } catch (error) {
      setSaveError(
        error === "invalid_key"
          ? "settings.cloud.error.invalidKey"
          : error === "invalid_base_url"
            ? "settings.cloud.error.invalidBaseUrl"
            : "settings.cloud.error.saveFailed",
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmRemove(false);
    if (busy) return;
    setBusy(true);
    try {
      await aiConnections.deleteKey(target);
      setTest({ kind: "idle" });
      toast({ kind: "success", messageKey: "settings.cloud.removedToast" });
      refreshKeyStatuses();
      setFocusNext("field");
    } catch {
      toast({ kind: "danger", messageKey: "settings.cloud.error.removeFailed" });
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTest({ kind: "testing" });
    try {
      setTest({ kind: "ok", models: await aiConnections.listModels(target) });
    } catch (error) {
      setTest({ kind: "error", error: isAiError(error) ? error : { code: "unexpected" } });
    }
  };

  const useForJarvis = () => {
    getDb().prefs.set({ aiProvider: route });
    const message = t("settings.route.switched", { name: title });
    toast({ kind: "success", message });
    announce(message);
  };

  const chosen =
    prefs.aiModels[key] ?? (target.provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "");
  // Read the stored choices now, not this render's copy of them.
  const chooseModel = (id: string) =>
    getDb().prefs.set({ aiModels: { ...getDb().prefs.get().aiModels, [key]: id } });

  const statusText =
    status === null
      ? null
      : !status.present
        ? t("settings.cloud.keyNone")
        : status.last4
          ? t("settings.cloud.keySaved", { last4: status.last4 })
          : t("settings.cloud.keySavedNoKey");
  const canSave = !busy && (custom ? draftAddress.trim() !== "" : draftKey.trim() !== "");

  return (
    <section
      className={`cloud-card${inUse ? " is-in-use" : ""}`}
      aria-labelledby={`${idBase}-title`}
      data-connected={status?.present ? "true" : "false"}
    >
      <div className="cloud-card__head">
        <span className="cloud-card__mark" aria-hidden>
          <Cloud size={16} />
        </span>
        <div className="cloud-card__names">
          <h3 id={`${idBase}-title`} className="cloud-card__title">
            {title}
          </h3>
          {hint && <p className="muted cloud-card__hint">{hint}</p>}
        </div>
        {inUse && <span className="badge badge--primary">{t("settings.route.inUse")}</span>}
        {statusText && (
          <span className={`cloud-card__status${status?.present ? " is-on" : ""}`}>
            <span className={`dot ${status?.present ? "dot--success" : "dot--muted"}`} aria-hidden />
            {statusText}
            {custom && status?.present && status.baseUrl && (
              <span className="mono cloud-card__address"> · {status.baseUrl}</span>
            )}
          </span>
        )}
      </div>

      {preset && (
        <div className="cloud-card__line">
          <label className="cloud-card__label" htmlFor={`${idBase}-preset`}>
            {t("settings.cloud.service")}
          </label>
          <select
            id={`${idBase}-preset`}
            className="select cloud-card__select"
            value={preset}
            onChange={(e) => getDb().prefs.set({ aiOpenAiPreset: e.target.value as OpenAiPreset })}
          >
            {OPENAI_PRESETS.map((option) => (
              <option key={option} value={option}>
                {t(`settings.cloud.preset.${option}`)}
              </option>
            ))}
          </select>
        </div>
      )}

      {showForm && (
        <form className="cloud-card__form" onSubmit={(e) => void save(e)}>
          {custom && (
            <Field label={t("settings.cloud.address")}>
              {(id) => (
                <>
                  <input
                    id={id}
                    ref={firstFieldRef}
                    className="input"
                    value={draftAddress}
                    placeholder="https://…"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setDraftAddress(e.target.value)}
                  />
                  <p className="setting-hint">{t("settings.cloud.addressHint")}</p>
                </>
              )}
            </Field>
          )}
          <Field label={t("settings.cloud.key")}>
            {(id) => (
              <>
                <input
                  id={id}
                  ref={custom ? undefined : firstFieldRef}
                  type="password"
                  className="input"
                  value={draftKey}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setDraftKey(e.target.value)}
                />
                {custom && <p className="setting-hint">{t("settings.cloud.keyLocalHint")}</p>}
              </>
            )}
          </Field>
          <div className="cloud-card__actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={!canSave}>
              {t("action.save")}
            </button>
            {editing && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setEditing(false);
                  setDraftKey("");
                  setDraftAddress("");
                  setSaveError(null);
                  setFocusNext("test");
                }}
              >
                {t("action.cancel")}
              </button>
            )}
          </div>
          {saveError && (
            <p className="callout callout--warning cloud-card__message" role="alert">
              {t(saveError)}
            </p>
          )}
        </form>
      )}

      {showTest && (
        <div className="cloud-card__actions cloud-card__toolbar">
          <button
            ref={testRef}
            type="button"
            className="btn btn--secondary btn--sm"
            aria-disabled={test.kind === "testing" || undefined}
            onClick={() => {
              if (test.kind !== "testing") void runTest();
            }}
          >
            {test.kind === "testing" ? (
              <Loader2 size={13} className="spin" aria-hidden />
            ) : (
              <PlugZap size={13} aria-hidden />
            )}{" "}
            {test.kind === "testing" ? t("settings.cloud.testing") : t("settings.cloud.test")}
          </button>
          {!inUse && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={useForJarvis}>
              {t("settings.route.useThis")}
            </button>
          )}
          <span className="cloud-card__spacer" />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setEditing(true);
              setFocusNext("field");
            }}
          >
            {t("settings.cloud.change")}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm cloud-card__remove"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) setConfirmRemove(true);
            }}
          >
            <Trash2 size={13} aria-hidden /> {t("settings.cloud.removeKey")}
          </button>
        </div>
      )}

      {test.kind === "ok" && (
        <p className="cloud-card__result" role="status">
          <CheckCircle2 size={13} aria-hidden />{" "}
          {t("settings.cloud.connected", { count: test.models.length })}
        </p>
      )}
      {test.kind === "error" && (
        <p className="cloud-card__result is-error" role="alert">
          {aiErrorText(t, test.error)}
        </p>
      )}

      {test.kind === "ok" && test.models.length > 0 && (
        <div className="cloud-card__line">
          <label className="cloud-card__label" htmlFor={`${idBase}-model`}>
            {t("settings.cloud.model")}
          </label>
          <ModelSelect
            id={`${idBase}-model`}
            models={test.models}
            chosen={chosen}
            placeholder={t("settings.cloud.chooseModel")}
            onChoose={chooseModel}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title={t("settings.cloud.removeConfirmTitle", { name: title })}
        body={t(inUse ? "settings.cloud.removeConfirmInUse" : "settings.cloud.removeConfirmBody")}
        confirmLabel={t("settings.cloud.removeKey")}
        danger
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => void remove()}
      />
    </section>
  );
}

/** The models the service listed. Nothing is saved until the user picks
    one; a choice the list no longer has stays shown, so it never changes
    without the user. */
function ModelSelect({
  id,
  models,
  chosen,
  placeholder,
  onChoose,
}: {
  id: string;
  models: ModelInfo[];
  chosen: string;
  placeholder: string;
  onChoose: (id: string) => void;
}) {
  const listed = models.some((model) => model.id === chosen);
  return (
    <select
      id={id}
      className="select cloud-card__select"
      value={chosen}
      onChange={(e) => onChoose(e.target.value)}
    >
      {!chosen && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {chosen && !listed && <option value={chosen}>{chosen}</option>}
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.name === model.id ? model.id : `${model.name} (${model.id})`}
        </option>
      ))}
    </select>
  );
}
