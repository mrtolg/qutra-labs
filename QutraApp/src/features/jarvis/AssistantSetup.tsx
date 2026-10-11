import { useEffect, useState } from "react";
import { getDb, usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import {
  dismissPrivateLabPrompt,
  grantAnswerOnly,
  grantToolProposals,
  restoreToolProposals,
  switchToAnswerOnly,
} from "@/domain/assistantConsent";
import { EnablePrivateLabButton } from "@/components/EnablePrivateLabButton";
import {
  type AssistantHealth,
  localAssistant,
} from "@/lib/localAssistant/client";
import { AssistantReadiness } from "./AssistantReadiness";

export function AssistantSetup({
  askPrivateLab,
  onAskPrivateLab,
}: {
  askPrivateLab: boolean;
  onAskPrivateLab: (next: boolean) => void;
}) {
  const { t } = useT();
  const prefs = usePreferences();
  const db = getDb();
  const [health, setHealth] = useState<AssistantHealth | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!prefs.localAssistantEnabled) {
      setHealth(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    void localAssistant
      .checkHealth({
        localAssistantEnabled: true,
        ollamaModel: prefs.ollamaModel,
      })
      .then((report) => {
        if (!cancelled) setHealth(report);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prefs.localAssistantEnabled, prefs.ollamaModel]);

  if (askPrivateLab && !prefs.privateToolsEnabled) {
    return (
      <div className="stack" style={{ gap: "var(--sp-3)" }} data-testid="assistant-setup-q2">
        <AssistantReadiness health={health} checking={checking} />
        <p className="muted">{t("jarvis.setup.q2Body")}</p>
        <EnablePrivateLabButton testId="assistant-enable-private-lab" />
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="assistant-q2-decline"
          onClick={() => {
            db.prefs.set(dismissPrivateLabPrompt());
            onAskPrivateLab(false);
          }}
        >
          {t("jarvis.setup.notNow")}
        </button>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: "var(--sp-3)" }} data-testid="local-assistant-off">
      <AssistantReadiness health={health} checking={checking} />
      <p className="muted">{t("jarvis.setup.endpointDisclosure")}</p>
      {prefs.assistantAgentAwaitingConfirmation && <RestoreToolProposals />}
      <div className="stack" style={{ gap: "var(--sp-2)" }}>
        <button
          type="button"
          className="btn btn--primary"
          data-testid="assistant-enable-answer-only"
          onClick={() => db.prefs.set(grantAnswerOnly())}
        >
          {t("jarvis.setup.answerOnly")}
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="assistant-enable-tool-proposals"
          onClick={() => {
            const labOff = !db.prefs.get().privateToolsEnabled;
            db.prefs.set(grantToolProposals());
            if (labOff) onAskPrivateLab(true);
          }}
        >
          {t("jarvis.setup.toolProposals")}
        </button>
        {/* The pending restore above already carries this explanation. */}
        {!prefs.assistantAgentAwaitingConfirmation && (
          <p className="muted" style={{ fontSize: "var(--fs-12)", margin: 0 }}>
            {t("jarvis.setup.toolProposalsExplain")}
          </p>
        )}
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="assistant-setup-not-now"
        >
          {t("jarvis.setup.notNow")}
        </button>
      </div>
      {/* The note on how the engine is told apart from a program that
          pretends to be it is printed by the readiness block above, which
          always shows it while Jarvis is off: saying it again here would put
          the same paragraph on the screen twice. */}
      <p className="faint" style={{ fontSize: "var(--fs-12)", margin: 0 }} data-testid="assistant-setup-endpoint">
        {t("jarvis.setup.endpointSet")}
      </p>
    </div>
  );
}

export function RestoreToolProposals() {
  const { t } = useT();
  const prefs = usePreferences();
  const db = getDb();

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }} data-testid="assistant-restore-proposals">
      <p className="muted" style={{ fontSize: "var(--fs-12)", margin: 0 }}>
        {t("jarvis.setup.toolProposalsExplain")}
      </p>
      {prefs.assistantAutoApproveReads && (
        <p className="muted" style={{ fontSize: "var(--fs-12)", margin: 0 }}>
          {t("jarvis.restore.autoApproveOn")}
        </p>
      )}
      <button
        type="button"
        className="btn btn--secondary"
        data-testid="assistant-restore-tool-proposals"
        onClick={() => db.prefs.set(restoreToolProposals())}
      >
        {t("jarvis.restore.action")}
      </button>
    </div>
  );
}

/** Answer-only or tool proposals, as chips beside the composer, with the
    switch between them. The full sentence stays for screen readers. While a
    restore is waiting for confirmation the transcript says so instead. */
export function AssistantModeChips({
  onAskPrivateLab,
}: {
  onAskPrivateLab: (next: boolean) => void;
}) {
  const { t } = useT();
  const prefs = usePreferences();
  const db = getDb();

  if (prefs.assistantAgentAwaitingConfirmation) return null;
  const savedLabOff = prefs.assistantAgentToolsEnabled && !prefs.privateToolsEnabled;

  return (
    <span className="asst-mode" data-testid="assistant-permission-status">
      {savedLabOff && (
        <span className="asst-chip asst-chip--warn">{t("jarvis.permission.savedLabOff")}</span>
      )}
      {prefs.assistantAgentToolsEnabled ? (
        <>
          <span className="asst-chip asst-chip--live">{t("jarvis.mode.proposalsOn")}</span>
          <button
            type="button"
            className="asst-linkbtn"
            data-testid="assistant-switch-answer-only"
            onClick={() => db.prefs.set(switchToAnswerOnly())}
          >
            {t("jarvis.mode.answerOnly")}
          </button>
        </>
      ) : (
        <>
          {/* Answering only is the default and complete on its own; the
              switch to proposals is enough to show which mode this is. */}
          <span className="sr-only">{t("jarvis.mode.answerOnlyComplete")}</span>
          <button
            type="button"
            className="asst-linkbtn"
            data-testid="assistant-enable-proposals-inline"
            title={t("jarvis.mode.answerOnlyComplete")}
            onClick={() => {
              const labOff = !prefs.privateToolsEnabled;
              db.prefs.set(grantToolProposals());
              if (labOff) onAskPrivateLab(true);
            }}
          >
            {t("jarvis.mode.enableProposals")}
          </button>
        </>
      )}
    </span>
  );
}
