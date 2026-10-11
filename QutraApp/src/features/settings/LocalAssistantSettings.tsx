import { useEffect, useState } from "react";
import { Bot, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { ASSISTANT_CONTEXT_CHOICES, type AssistantContextTokens } from "@/domain/localAssistant";
import { getDb, useCollection, usePreferences } from "@/lib/db/database";
import { clearAllConversations } from "@/lib/db/conversations";
import { type AssistantHealth, localAssistant } from "@/lib/localAssistant/client";
import { AssistantReadiness } from "@/features/jarvis/AssistantReadiness";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useT } from "@/lib/i18n";

/* Settings -> Jarvis on the local model (ADR 0010 / 0016, §3.14).

   The readiness check never runs on mount: only when the user presses Test
   connection or picks a model. Opening Settings starts no engine and
   contacts no address; the engine strip only shows what Rust found on disk. */

export function LocalAssistantSettings() {
  const { t } = useT();
  const prefs = usePreferences();
  const db = getDb();

  const [health, setHealth] = useState<AssistantHealth | null>(null);
  const [checking, setChecking] = useState(false);
  /** Clear-all is an erase on disk: a failed one says what is still kept. */
  const [erase, setErase] = useState<"idle" | "pending" | "failed" | "done">("idle");
  /** The clear button was pressed; nothing is erased until it is confirmed. */
  const [confirmClear, setConfirmClear] = useState(false);

  // A report from before the switch was turned off describes traffic that no
  // longer happens; do not keep showing its endpoint or model.
  useEffect(() => {
    if (!prefs.localAssistantEnabled) setHealth(null);
  }, [prefs.localAssistantEnabled]);

  /* Everything the lab reported, plus the preferred model even when the lab
     does not have it. Including it keeps the selection stable: dropping it
     would make the <select> fall back to some other installed model and change
     what the user chose without telling them. */
  const installedModels = health
    ? Array.from(new Set([...health.models, prefs.ollamaModel]))
    : [];
  const conversations = useCollection("conversations");
  const historyCount = conversations.reduce((sum, c) => sum + c.messages.length, 0);

  /** Probe with an explicit model so a just-written preference is never read
      back stale from this render's `prefs`. */
  const probe = async (ollamaModel: string) => {
    setChecking(true);
    try {
      setHealth(
        await localAssistant.checkHealth({
          localAssistantEnabled: true,
          ollamaModel,
        }),
      );
    } finally {
      setChecking(false);
    }
  };

  const runCheck = () => probe(prefs.ollamaModel);

  const selectModel = async (model: string) => {
    db.prefs.set({ ollamaModel: model });
    // Re-probe against the new model so the status reflects the choice the user
    // just made instead of stalling until they press the button again.
    await probe(model);
  };

  /* Turning the assistant off hides the chat but does not erase what was said,
     so the control to erase it has to be reachable from here — otherwise the
     only way to clear a transcript is to turn the feature back on. */
  const clearHistory = async () => {
    // Every conversation, titles included, behind any turn still
    // being written, so nothing erased is written back.
    setErase("pending");
    try {
      await clearAllConversations(db);
      setErase("done");
    } catch (caught) {
      console.error("assistant conversations not cleared", caught);
      setErase("failed");
    }
  };

  return (
    <div className="local-model" data-testid="local-assistant-settings">
      <div className="local-model__head">
        <span className="local-model__mark" aria-hidden>
          <Bot size={16} />
        </span>
        <div className="local-model__names">
          <strong className="local-model__title">{t("localAssistant.section")}</strong>
          <p className="muted local-model__hint">{t("localAssistant.sectionHint")}</p>
        </div>
      </div>

      <div className="local-model__readiness">
        <AssistantReadiness
          health={health}
          checking={checking}
          onCheck={runCheck}
          showCheckButton
        />
      </div>

      {/* The picker lists only what Rust found on this computer -- the app's
          models folder and Ollama's store, models the engine runs or will
          after their one-time copy. There is deliberately no catalog of
          downloadable models and nothing is ever downloaded automatically.

          Before a health check has run we do not know what is installed, so the
          current selection is shown as text rather than a dropdown with one
          fabricated entry. */}
      <div className="setting-row">
        <label className="setting-label" htmlFor="local-assistant-model">
          {t("localAssistant.model")}
        </label>
        {installedModels.length > 0 ? (
          <select
            id="local-assistant-model"
            className="select"
            value={prefs.ollamaModel}
            onChange={(e) => void selectModel(e.target.value)}
            data-testid="local-assistant-model-picker"
          >
            {/* The preferred model stays selectable even when it is not
                installed, so the selection never silently changes underneath
                the user just because the lab is missing it right now. */}
            {installedModels.map((m) => (
              <option key={m} value={m}>
                {m}
                {m === prefs.ollamaModel && !health?.models.includes(m)
                  ? ` — ${t("localAssistant.notInstalled")}`
                  : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="mono" data-testid="local-assistant-model">
            {prefs.ollamaModel}
          </span>
        )}
      </div>

      {health && health.models.length > 0 && (
        <div className="setting-row">
          <div className="setting-label">{t("localAssistant.modelsFound")}</div>
          <span className="faint" style={{ fontSize: "var(--fs-12)" }}>
            {health.models.length}
          </span>
        </div>
      )}

      <p className="faint local-model__note">
        <ShieldCheck size={13} aria-hidden /> {t("localAssistant.noActions")}
      </p>

      {/* Reachable whether or not the assistant is on. Turning it off hides the
          chat but keeps the transcript, so without this the only way to erase a
          conversation was to switch the feature back on to find the button. */}
      <div className="setting-row">
        <div>
          <div className="setting-label">{t("localAssistant.historyTitle")}</div>
          <div className="setting-hint">
            {t("localAssistant.historyRetained", { count: historyCount })}
          </div>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setConfirmClear(true)}
          disabled={historyCount === 0 || erase === "pending"}
          data-testid="local-assistant-clear-history"
        >
          <Trash2 size={13} aria-hidden /> {t("localAssistant.clearChat")}
        </button>
      </div>
      {erase === "pending" && (
        <p className="faint" style={{ fontSize: "var(--fs-12)", margin: 0 }}>
          <Loader2 size={13} className="spin" aria-hidden /> {t("localAssistant.clearingHistory")}
        </p>
      )}
      {erase === "failed" && (
        <div
          className="callout callout--warning flex"
          style={{ fontSize: "var(--fs-12)", gap: 8, alignItems: "center" }}
          role="alert"
        >
          <span style={{ flex: 1 }}>
            {t("localAssistant.clearHistoryFailed", { count: historyCount })}
          </span>
          <button type="button" className="btn btn--sm" onClick={() => void clearHistory()}>
            {t("localAssistant.retry")}
          </button>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {erase === "done" ? t("localAssistant.historyCleared") : ""}
      </p>
      <ConfirmDialog
        open={confirmClear}
        danger
        title={t("localAssistant.clearHistoryConfirmTitle")}
        body={t("localAssistant.clearHistoryConfirmBody")}
        confirmLabel={t("localAssistant.clearChat")}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          void clearHistory();
        }}
      />

      {/* Advanced is collapsed by default (§3.14/9). */}
      <details className="local-model__advanced">
        <summary>
          {t("localAssistant.advanced")}
        </summary>

        {/* Read-only. The renderer never chooses the origin, so it never
            shows one Rust did not report: switched off, nothing is contacted;
            while the engine does not run the model, there is no address yet
            (Rust starts it on a free 127.0.0.1 port); a reported origin is the
            last check's answer, and each chat answer says where its own turn
            went. An address stored by an older version is not read. */}
        <div className="setting-row" style={{ marginTop: "var(--sp-2)" }}>
          <div className="setting-label">{t("localAssistant.baseUrl")}</div>
          {!prefs.localAssistantEnabled ? (
            <span className="muted" data-testid="local-assistant-endpoint">
              {t("localAssistant.endpointOff")}
            </span>
          ) : health?.endpoint ? (
            <span className="flex" style={{ gap: 8, alignItems: "baseline" }}>
              <code className="mono" data-testid="local-assistant-endpoint">
                {health.endpoint}
              </code>
              <span
                className="faint"
                style={{ fontSize: "var(--fs-12)" }}
                data-testid="local-assistant-endpoint-when"
              >
                {t("localAssistant.endpointAtLastCheck")}
              </span>
            </span>
          ) : (
            <span className="muted" data-testid="local-assistant-endpoint">
              {t("localAssistant.endpointNotSelected")}
            </span>
          )}
        </div>
        <p className="faint" style={{ fontSize: "var(--fs-12)", margin: 0 }}>
          {t("localAssistant.identityUnverified")}
        </p>

        <div className="setting-row">
          <label className="setting-label" htmlFor="local-assistant-context-tokens">
            {t("localAssistant.contextTokens")}
          </label>
          <select
            id="local-assistant-context-tokens"
            className="select"
            value={prefs.ollamaContextTokens}
            onChange={(e) =>
              db.prefs.set({
                ollamaContextTokens: Number(e.target.value) as AssistantContextTokens,
              })
            }
          >
            {ASSISTANT_CONTEXT_CHOICES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </details>
    </div>
  );
}
