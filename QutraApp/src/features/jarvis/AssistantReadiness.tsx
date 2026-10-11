import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { getBridge } from "@/lib/bridge";
import { usePreferences } from "@/lib/db/database";
import {
  type AssistantHealth,
  type AssistantModels,
  type AssistantStatus,
  localAssistant,
} from "@/lib/localAssistant/client";
import { assistantErrorMessage } from "@/lib/localAssistant/assistantErrorMessage";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { LocalEnginePanel } from "@/features/localEngine/LocalEnginePanel";
// Settings shows this panel before Jarvis, and its code, ever loaded.
import "./assistant.css";

const STATUS_MESSAGE = {
  disabled: "localAssistant.statusDisabled",
  unknown: "localAssistant.statusUnknown",
  connecting: "localAssistant.statusConnecting",
  ready: "localAssistant.statusReady",
  model_missing: "localAssistant.statusModelMissing",
  engine_missing: "localAssistant.statusEngineMissing",
  needs_prepare: "localAssistant.statusNeedsPrepare",
  unsupported: "localAssistant.statusUnsupported",
  offline: "localAssistant.statusOffline",
  unavailable: "localAssistant.statusUnavailable",
  error: "localAssistant.statusError",
} as const satisfies Record<AssistantStatus, MessageKey>;

export function AssistantReadiness({
  health,
  checking,
  onCheck,
  showCheckButton = false,
  compact = false,
}: {
  health: AssistantHealth | null;
  checking: boolean;
  onCheck?: () => void;
  showCheckButton?: boolean;
  /** In the conversation: one line of status with the retry, the next step,
      and the address, model and shell behind a Details toggle. */
  compact?: boolean;
}) {
  const { t } = useT();
  const prefs = usePreferences();
  const [models, setModels] = useState<AssistantModels | null>(null);
  const [resolvedShell, setResolvedShell] = useState<string | null>(null);

  const native = localAssistant.available();
  const status: AssistantStatus = !prefs.localAssistantEnabled
    ? "disabled"
    : !native
      ? (health?.status ?? "unavailable")
      : checking
        ? "connecting"
        : (health?.status ?? "unknown");

  // Tool support only matters, and is only asked, when tool proposals are on.
  const needCapabilities = health?.status === "ready" && prefs.assistantAgentToolsEnabled;

  useEffect(() => {
    if (!native) {
      setResolvedShell(null);
      return;
    }
    let cancelled = false;
    void getBridge()
      .terminal.resolvedShell()
      .then((report) => {
        if (!cancelled) setResolvedShell(report.program);
      })
      .catch(() => {
        if (!cancelled) setResolvedShell(null);
      });
    return () => {
      cancelled = true;
    };
  }, [native]);

  useEffect(() => {
    if (!prefs.localAssistantEnabled || !native || !needCapabilities) {
      setModels(null);
      return;
    }
    let cancelled = false;
    void localAssistant
      .listModels({ localAssistantEnabled: true })
      .then((report) => {
        if (!cancelled) setModels(report);
      });
    return () => {
      cancelled = true;
    };
  }, [prefs.localAssistantEnabled, native, needCapabilities]);

  const selectedTools = models?.models.find((model) => model.name === prefs.ollamaModel)?.tools;
  // Only the selected model's own answer counts: another model declaring
  // tools does not stand in for it. Unknown (null: no chat template in the
  // file, so the engine uses a generic one) is not "no", since such a model
  // may still call tools; only the model's own "no" stands in the way.
  const toolsMissing = prefs.assistantAgentToolsEnabled && selectedTools === false;
  const allGreen = native && health?.status === "ready" && !toolsMissing;

  const checkButton = showCheckButton && onCheck && prefs.localAssistantEnabled && (
    <button
      type="button"
      className="btn btn--sm"
      disabled={checking}
      onClick={() => void onCheck()}
      data-testid="local-assistant-test-connection"
    >
      {status === "offline" || status === "error"
        ? t("localAssistant.retry")
        : t("localAssistant.testConnection")}
    </button>
  );
  // In Settings the engine strip always shows (start, stop, the models); in
  // the conversation only when something stands in the way.
  const nextStep = (!allGreen || !compact) && (
    <ReadinessNextStep
      native={native}
      enabled={prefs.localAssistantEnabled}
      status={status}
      health={health}
      toolsMissing={toolsMissing}
      compact={compact}
      onChanged={onCheck}
    />
  );

  if (compact) {
    return (
      <section className="asst-ready" data-testid="assistant-readiness">
        {!native && (
          <p className="callout callout--warning asst-small" data-testid="readiness-browser">
            {t("localAssistant.desktopOnly")}
          </p>
        )}
        <div className="asst-ready__top">
          {checking ? (
            <Loader2 size={15} className="spin" aria-hidden />
          ) : (
            <AlertTriangle size={15} className="asst-ready__ico" aria-hidden />
          )}
          <strong data-testid="local-assistant-status">{t(STATUS_MESSAGE[status])}</strong>
          <span className="asst-grow" />
          {checkButton}
        </div>
        {nextStep}
        {(health?.endpoint || health?.selectedModel || resolvedShell) && (
          <details className="asst-ready__more">
            <summary>{t("readiness.details")}</summary>
            <dl className="asst-kv">
              {health?.endpoint && (
                <div>
                  <dt>{t("localAssistant.baseUrl")}</dt>
                  <dd className="mono" data-testid="local-assistant-health-endpoint">
                    {health.endpoint}
                  </dd>
                </div>
              )}
              {health?.selectedModel && (
                <div>
                  <dt>{t("localAssistant.model")}</dt>
                  <dd className="mono" data-testid="local-assistant-selected-model">
                    {health.selectedModel}
                  </dd>
                </div>
              )}
              {resolvedShell && (
                <div data-testid="readiness-shell">
                  <dt>{t("readiness.shellLabel")}</dt>
                  <dd className="mono">{resolvedShell}</dd>
                </div>
              )}
            </dl>
            {health?.endpoint && (
              <p className="asst-small faint">{t("localAssistant.identityUnverified")}</p>
            )}
          </details>
        )}
      </section>
    );
  }

  return (
    <section className="stack" style={{ gap: "var(--sp-2)" }} data-testid="assistant-readiness">
      {!native && (
        <p className="callout callout--warning" style={{ fontSize: "var(--fs-12)" }} data-testid="readiness-browser">
          {t("localAssistant.desktopOnly")}
        </p>
      )}

      <div className="setting-row">
        <div className="setting-label">{t("localAssistant.statusLabel")}</div>
        <span className="flex" style={{ gap: 6, alignItems: "center" }}>
          {checking && <Loader2 size={14} className="spin" aria-hidden />}
          <strong data-testid="local-assistant-status">{t(STATUS_MESSAGE[status])}</strong>
        </span>
      </div>

      {health?.endpoint && (
        <div className="setting-row">
          <div className="setting-label">{t("localAssistant.baseUrl")}</div>
          <code className="mono" data-testid="local-assistant-health-endpoint">
            {health.endpoint}
          </code>
        </div>
      )}
      {health?.selectedModel && (
        <div className="setting-row">
          <div className="setting-label">{t("localAssistant.model")}</div>
          <code className="mono" data-testid="local-assistant-selected-model">
            {health.selectedModel}
          </code>
        </div>
      )}
      {resolvedShell && (
        <div className="setting-row" data-testid="readiness-shell">
          <div className="setting-label">{t("readiness.shellLabel")}</div>
          <code className="mono">{resolvedShell}</code>
        </div>
      )}
      {(health?.endpoint || !prefs.localAssistantEnabled) && (
        <p className="faint" style={{ fontSize: "var(--fs-12)", margin: 0 }}>
          {t("localAssistant.identityUnverified")}
        </p>
      )}

      {checkButton && (
        <div className="flex" style={{ gap: 8 }}>
          {checkButton}
        </div>
      )}

      {nextStep}
    </section>
  );
}

function ReadinessNextStep({
  native,
  enabled,
  status,
  health,
  toolsMissing,
  compact,
  onChanged,
}: {
  native: boolean;
  enabled: boolean;
  status: AssistantStatus;
  health: AssistantHealth | null;
  toolsMissing: boolean;
  compact: boolean;
  onChanged?: () => void;
}) {
  const { t } = useT();

  if (!native) return null;

  if (!enabled) {
    return (
      <p className="muted" style={{ fontSize: "var(--fs-12)", margin: 0 }} data-testid="readiness-start">
        {t("readiness.enableToCheck")}
      </p>
    );
  }

  return (
    <>
      {status === "unknown" && (
        <p className="muted" style={{ fontSize: "var(--fs-12)", margin: 0 }} data-testid="readiness-check-hint">
          {t("readiness.checkToSee")}
        </p>
      )}
      {status === "error" && (
        <p className="callout callout--warning" style={{ fontSize: "var(--fs-12)" }} data-testid="readiness-error">
          {health?.detail ? assistantErrorMessage(t, health.detail) : t("jarvis.error.generic")}
        </p>
      )}
      {toolsMissing && (
        <p className="callout callout--warning" style={{ fontSize: "var(--fs-12)" }} data-testid="readiness-no-tools">
          {t("jarvis.model.agentNeedsTools")}
        </p>
      )}
      <LocalEnginePanel compact={compact} onChanged={onChanged} />
    </>
  );
}
