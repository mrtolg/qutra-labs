import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, Cloud, KeyRound, Loader2, PlugZap, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  aiConnections,
  DEFAULT_ANTHROPIC_MODEL,
  detectKeyProvider,
  isAiError,
  MAX_KEYS,
  targetKey,
  targetOfKeyProvider,
  type AiError,
  type KeyEntry,
  type ChatKeyProvider,
  type KeyProvider,
  type ModelInfo,
} from "@/lib/aiConnections";
import { aiErrorText } from "@/lib/aiErrorText";
import { getDb, usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { modelDisplayName } from "@/lib/modelNames";
import { useUi } from "@/state/ui";
import { refreshKeyStatuses } from "./cloudKeyStatus";

/**
 * Cloud keys for Jarvis (spec 2026-10-07 §7): one list of up to ten API
 * keys. The service is recognised from how a key starts. A key goes to Rust
 * and never comes back: its row says only the service and the last four
 * characters. Below the list, each service that has a key shows its model
 * and a test; the model the user picks is kept in preferences for when
 * Jarvis talks through it. Which connection Jarvis uses is chosen in
 * `JarvisRoutePicker`, or with a service's own "Use for Jarvis" button.
 * When a service has several keys, the newest one is used.
 */
export function CloudConnections() {
  const { t } = useT();

  if (!aiConnections.available()) {
    return (
      <div className="cloud-connections">
        <p className="muted cloud-connections__note">{t("settings.cloud.desktopOnly")}</p>
      </div>
    );
  }
  return <Keys />;
}

const PROVIDER_NAME: Record<KeyProvider, MessageKey> = {
  anthropic: "settings.cloud.anthropicName",
  openai: "settings.cloud.preset.openai",
  brave: "settings.cloud.braveName",
};

/** The Claude models offered before the service has been asked for its list. */
const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", name: "claude-opus-5-5" },
  { id: "claude-sonnet-5-5", name: "claude-sonnet-5-5" },
  { id: "claude-haiku-5-5", name: "claude-haiku-5-5" },
];

function Keys() {
  const { t } = useT();
  const toast = useUi((s) => s.toast);
  const [entries, setEntries] = useState<KeyEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<KeyEntry | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prefs = usePreferences();

  const reload = useCallback(async () => {
    try {
      setEntries(await aiConnections.listKeys());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
      setEntries((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const provider = detectKeyProvider(draft);
  const typed = draft.trim() !== "";
  const unknown = typed && provider === null;
  const full = entries !== null && entries.length >= MAX_KEYS;
  const canSave = !busy && typed && provider !== null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setSaveError(null);
    try {
      const added = await aiConnections.addKey(draft.trim());
      // The key leaves the page's state as soon as Rust has it.
      setDraft("");
      // Keys go through the OpenAI service itself, not another preset.
      if (added.provider === "openai") getDb().prefs.set({ aiOpenAiPreset: "openai" });
      await reload();
      refreshKeyStatuses();
      toast({ kind: "success", messageKey: "settings.cloud.savedToast" });
      inputRef.current?.focus();
    } catch (error) {
      setSaveError(
        error === "unknown_key_prefix"
          ? "settings.cloud.keys.unknownPrefix"
          : error === "invalid_key"
            ? "settings.cloud.error.invalidKey"
            : error === "too_many_keys"
              ? "settings.cloud.keys.full"
              : "settings.cloud.error.saveFailed",
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: KeyEntry) => {
    setRemoving(null);
    if (busy) return;
    setBusy(true);
    try {
      await aiConnections.removeKey(entry.id);
      await reload();
      refreshKeyStatuses();
      toast({ kind: "success", messageKey: "settings.cloud.removedToast" });
      inputRef.current?.focus();
    } catch {
      toast({ kind: "danger", messageKey: "settings.cloud.error.removeFailed" });
    } finally {
      setBusy(false);
    }
  };

  const providers = useMemo(
    () => (["anthropic", "openai"] as const).filter((p) => entries?.some((e) => e.provider === p)),
    [entries],
  );
  // Removing a service's only key leaves Jarvis without one for it.
  const removingInUse =
    removing !== null &&
    removing.provider !== "brave" &&
    prefs.aiProvider === (removing.provider === "anthropic" ? "anthropic" : "openai_compat") &&
    entries?.filter((e) => e.provider === removing.provider).length === 1;

  return (
    <div className="cloud-connections">
      <section className="cloud-card cloud-keys" aria-labelledby="cloud-keys-title">
        <div className="cloud-card__head">
          <span className="cloud-card__mark" aria-hidden>
            <KeyRound size={16} />
          </span>
          <div className="cloud-card__names">
            <h3 id="cloud-keys-title" className="cloud-card__title">
              {t("settings.cloud.keys.title")}
            </h3>
            <p className="muted cloud-card__hint">{t("settings.cloud.keys.order")}</p>
          </div>
        </div>

        {entries !== null && entries.length > 0 && (
          <ul className="cloud-keys__list">
            {entries.map((entry) => {
              const name = t(PROVIDER_NAME[entry.provider]);
              const masked = entry.last4 ? `••••${entry.last4}` : "••••";
              return (
                <li key={entry.id} className="cloud-keys__row" data-provider={entry.provider}>
                  <span className="cloud-card__mark" aria-hidden>
                    <Cloud size={14} />
                  </span>
                  <span className="cloud-keys__name">{name}</span>
                  <span className="cloud-keys__mask mono">{masked}</span>
                  <span className="cloud-card__spacer" />
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm cloud-card__remove"
                    aria-label={t("settings.cloud.keys.removeLabel", { name, masked })}
                    aria-disabled={busy || undefined}
                    onClick={() => {
                      if (!busy) setRemoving(entry);
                    }}
                  >
                    <Trash2 size={13} aria-hidden /> {t("settings.cloud.removeKey")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {entries !== null && entries.length === 0 && !loadFailed && (
          <p className="muted cloud-card__hint">{t("settings.cloud.keys.none")}</p>
        )}
        {loadFailed && (
          <p className="callout callout--warning cloud-card__message" role="alert">
            {t("settings.cloud.keys.loadFailed")}
          </p>
        )}

        {entries !== null && !full && (
          <form className="cloud-keys__form" onSubmit={(e) => void save(e)}>
            <div className="cloud-keys__line">
              <input
                ref={inputRef}
                type="password"
                className="input cloud-keys__input"
                value={draft}
                placeholder={t("settings.cloud.keys.placeholder")}
                aria-label={t("settings.cloud.keys.placeholder")}
                aria-invalid={unknown || undefined}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSaveError(null);
                }}
              />
              <button type="submit" className="btn btn--primary btn--sm" disabled={!canSave}>
                {t("action.save")}
              </button>
            </div>
            {provider && (
              <p className="faint cloud-keys__detected" role="status">
                <CheckCircle2 size={12} aria-hidden />{" "}
                {t("settings.cloud.keys.recognised", { name: t(PROVIDER_NAME[provider]) })}
              </p>
            )}
            {(unknown || saveError) && (
              <p className="callout callout--warning cloud-card__message" role="alert">
                {t(saveError ?? "settings.cloud.keys.unknownPrefix")}
              </p>
            )}
          </form>
        )}
        {full && <p className="muted cloud-card__hint">{t("settings.cloud.keys.full")}</p>}
      </section>

      {/* Another key is another model list and test: a new card per service,
          so nothing of the previous one can land on it. */}
      {providers.map((p) => (
        <ModelCard key={p} provider={p} />
      ))}

      <p className="faint cloud-connections__note">
        <KeyRound size={12} aria-hidden /> {t("settings.cloud.keysNote")}
      </p>

      <ConfirmDialog
        open={removing !== null}
        title={t("settings.cloud.removeConfirmTitle", {
          name: removing
            ? `${t(PROVIDER_NAME[removing.provider])} ••••${removing.last4 ?? ""}`
            : "",
        })}
        body={t(removingInUse ? "settings.cloud.removeConfirmInUse" : "settings.cloud.removeConfirmBody")}
        confirmLabel={t("settings.cloud.removeKey")}
        danger
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      />
    </div>
  );
}

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; models: ModelInfo[] }
  | { kind: "error"; error: AiError };

/** One service that has a key: its test, the model Jarvis uses through it. */
function ModelCard({ provider }: { provider: ChatKeyProvider }) {
  const { t } = useT();
  const prefs = usePreferences();
  const toast = useUi((s) => s.toast);
  const announce = useUi((s) => s.announce);
  const target = useMemo(() => targetOfKeyProvider(provider), [provider]);
  const key = targetKey(target);
  const title = t(PROVIDER_NAME[provider]);
  const route = target.provider;
  const inUse = prefs.aiProvider === route;
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const idBase = `cloud-${provider}`;

  const runTest = async () => {
    setTest({ kind: "testing" });
    try {
      setTest({ kind: "ok", models: await aiConnections.listModels(target) });
    } catch (error) {
      setTest({ kind: "error", error: isAiError(error) ? error : { code: "unexpected" } });
    }
  };

  const useForJarvis = () => {
    getDb().prefs.set({
      aiProvider: route,
      ...(provider === "openai" ? { aiOpenAiPreset: "openai" as const } : {}),
    });
    const message = t("settings.route.switched", { name: title });
    toast({ kind: "success", message });
    announce(message);
  };

  const chosen = prefs.aiModels[key] ?? (provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "");
  // Read the stored choices now, not this render's copy of them.
  const chooseModel = (id: string) =>
    getDb().prefs.set({ aiModels: { ...getDb().prefs.get().aiModels, [key]: id } });

  const models: ModelInfo[] =
    test.kind === "ok" ? test.models : provider === "anthropic" ? CLAUDE_MODELS : [];
  const inUseHere = inUse && (provider !== "openai" || prefs.aiOpenAiPreset === "openai");

  return (
    <section
      className={`cloud-card${inUseHere ? " is-in-use" : ""}`}
      aria-labelledby={`${idBase}-title`}
      data-connected="true"
    >
      <div className="cloud-card__head">
        <span className="cloud-card__mark" aria-hidden>
          <Cloud size={16} />
        </span>
        <div className="cloud-card__names">
          <h3 id={`${idBase}-title`} className="cloud-card__title">
            {title}
          </h3>
        </div>
        {inUseHere && <span className="badge badge--primary">{t("settings.route.inUse")}</span>}
      </div>

      <div className="cloud-card__actions cloud-card__toolbar">
        <button
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
        {!inUseHere && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={useForJarvis}>
            {t("settings.route.useThis")}
          </button>
        )}
      </div>

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

      {(models.length > 0 || chosen) && (
        <div className="cloud-card__line">
          <label className="cloud-card__label" htmlFor={`${idBase}-model`}>
            {t("settings.cloud.model")}
          </label>
          <ModelSelect
            id={`${idBase}-model`}
            models={models}
            chosen={chosen}
            placeholder={t("settings.cloud.chooseModel")}
            onChoose={chooseModel}
          />
          {chosen && modelDisplayName(chosen) !== chosen && (
            <span className="faint mono cloud-card__id" title={chosen}>
              {chosen}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** The models the service listed, by their readable names (the raw id is each
    option's tooltip). Nothing is saved until the user picks one; a choice the
    list no longer has stays shown, so it never changes without the user. */
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
      {chosen && !listed && (
        <option value={chosen} title={chosen}>
          {modelDisplayName(chosen)}
        </option>
      )}
      {models.map((model) => (
        <option key={model.id} value={model.id} title={model.id}>
          {modelDisplayName(model.id, model.name)}
        </option>
      ))}
    </select>
  );
}
