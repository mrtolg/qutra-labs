import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, EyeOff, LocateFixed, SendHorizontal, Square, X } from "lucide-react";
import { cloudErrorText, connectionName, refusalText } from "@/features/jarvis/CloudParts";
import { usePreferences } from "@/lib/db/database";
import { LOCALE_NAMES, useT, type Locale, type MessageKey } from "@/lib/i18n";
import { assistantErrorMessage } from "@/lib/localAssistant/assistantErrorMessage";
import { companionContext, type AppState } from "./appState";
import { guideFor, PAGE_NAME } from "./guides";
import { highlightGuideTarget } from "./highlight";
import { askCompanion, canAsk, routeFor, stopCompanionAnswer } from "./askCompanion";
import { useCompanionStore, type MiniFailure } from "./store";

/* The mini chat: the page's guide first (static steps, an outline on request),
   then a box for a free question. */

export function MiniChat({
  state,
  onClose,
  onHide,
}: {
  state: AppState;
  onClose: () => void;
  onHide: () => void;
}) {
  const { t, locale } = useT();
  const prefs = usePreferences();
  const navigate = useNavigate();
  const panelRef = useRef<HTMLElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const { messages, partial, busy, failure, draft } = useCompanionStore();

  // A step of the page's guide, the first one to begin with.
  const steps = guideFor(state.page);
  const [index, setIndex] = useState(0);
  const step = steps[Math.min(index, steps.length - 1)];
  const [pointed, setPointed] = useState<"shown" | "missing" | null>(null);

  const pageName = t(PAGE_NAME[state.page]);
  const settingsName = state.settingsSection
    ? t(`settings.${state.settingsSection}` as MessageKey)
    : undefined;

  // The panel takes the focus when it opens; Close returns it to the bubble.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, partial, failure]);

  const route = routeFor(prefs);
  const available = canAsk(prefs);
  const cloudName = route.cloudTarget ? connectionName(t, route.cloudTarget) : "";

  const point = () => {
    if (!step?.target) return;
    setPointed(highlightGuideTarget(step.target) ? "shown" : "missing");
  };

  const goTo = (next: number) => {
    setIndex(next);
    setPointed(null);
  };

  const ask = () => {
    const stepTexts = steps.map((item) => t(item.text));
    void askCompanion({
      question: draft,
      prefs,
      language: LOCALE_NAMES[locale as Locale],
      t,
      contextFor: (withRecords) =>
        companionContext(state, { pageName, settingsName, steps: stepTexts, withRecords }),
    });
  };

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!busy) ask();
    }
  };

  // Escape closes the chat and nothing else: inside the Settings dialog it
  // must not close Settings as well. A listener on the panel (not a prop) as
  // the panel is a dialog, not a control.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    panel.addEventListener("keydown", onKey);
    return () => panel.removeEventListener("keydown", onKey);
  }, []);

  const failureText = (item: MiniFailure): string => {
    switch (item.kind) {
      case "assistant":
        return assistantErrorMessage(t, item.code);
      case "cloud":
        return cloudErrorText(t, item.error);
      case "refusal":
        return refusalText(t, item.category);
      case "text":
        return t(item.key, item.params);
    }
  };
  const needsAssistant = !available || (failure?.kind === "assistant" && failure.code === "disabled");

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="companion__panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="companion-title"
      data-testid="companion-panel"
    >
      <header className="companion__head">
        <h2 id="companion-title" className="companion__title">
          {t("topbar.assistant")}
        </h2>
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--sm"
          onClick={onHide}
          aria-label={t("companion.hideHere")}
          title={t("companion.hideHere")}
          data-testid="companion-hide"
        >
          <EyeOff size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--sm"
          onClick={onClose}
          aria-label={t("action.close")}
          title={t("action.close")}
        >
          <X size={14} aria-hidden />
        </button>
      </header>

      <div className="companion__guide">
        <p className="companion__page">{t("companion.onPage", { page: pageName })}</p>
        {step && (
          <>
            <p className="companion__step" data-testid="companion-step">
              {t(step.text)}
            </p>
            <div className="companion__nav">
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--sm"
                onClick={() => goTo(index - 1)}
                disabled={index === 0}
                aria-label={t("companion.back")}
                title={t("companion.back")}
              >
                <ChevronLeft size={14} aria-hidden />
              </button>
              <span className="companion__count" aria-live="polite">
                {t("companion.stepOf", { current: index + 1, total: steps.length })}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--sm"
                onClick={() => goTo(index + 1)}
                disabled={index >= steps.length - 1}
                aria-label={t("companion.next")}
                title={t("companion.next")}
              >
                <ChevronRight size={14} aria-hidden />
              </button>
              <span className="companion__grow" />
              {step.target && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={point}
                  data-testid="companion-show"
                >
                  <LocateFixed size={13} aria-hidden /> {t("companion.show")}
                </button>
              )}
            </div>
            <p className="companion__note" role="status">
              {pointed === "shown" && t("companion.shown")}
              {pointed === "missing" && t("companion.notOnScreen")}
            </p>
          </>
        )}
      </div>

      <details className="companion__sees">
        <summary>{t("companion.sees")}</summary>
        <ul>
          <li>{t("companion.sees.page", { page: pageName })}</li>
          {settingsName && <li>{t("companion.sees.settings", { section: settingsName })}</li>}
          {!route.cloudTarget && state.investigation && (
            <li>{t("companion.sees.investigation", { name: state.investigation })}</li>
          )}
          {!route.cloudTarget && state.tool && (
            <li>{t("companion.sees.tool", { tool: state.tool })}</li>
          )}
        </ul>
        <p>{t("companion.sees.never")}</p>
        <p>
          {route.cloudTarget
            ? t("companion.goes.cloud", { name: cloudName })
            : t("companion.goes.local")}
        </p>
      </details>

      <div
        ref={logRef}
        className="companion__log"
        role="log"
        aria-live="polite"
        aria-label={t("companion.logLabel")}
        data-testid="companion-log"
      >
        {messages.map((message, position) => (
          <p key={position} className={`companion__msg companion__msg--${message.role}`}>
            {message.content}
          </p>
        ))}
        {busy && (
          <p className="companion__msg companion__msg--assistant" aria-busy>
            {partial || t("companion.thinking")}
          </p>
        )}
      </div>

      {failure && !needsAssistant && (
        <p className="companion__error" role="alert">
          {failureText(failure)}
        </p>
      )}

      {needsAssistant ? (
        <div className="companion__off">
          <p>{t("companion.needAssistant")}</p>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => {
              onClose();
              navigate("/jarvis");
            }}
          >
            {t("companion.openAssistant")}
          </button>
        </div>
      ) : (
        <form
          className="companion__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) ask();
          }}
        >
          <label className="sr-only" htmlFor="companion-question">
            {t("companion.askLabel")}
          </label>
          <textarea
            id="companion-question"
            className="textarea companion__input"
            rows={2}
            value={draft}
            placeholder={t("companion.askPlaceholder")}
            onChange={(event) => useCompanionStore.getState().setDraft(event.target.value)}
            onKeyDown={onComposerKey}
            maxLength={1200}
          />
          {busy ? (
            <button
              type="button"
              className="btn btn--secondary btn--icon"
              onClick={stopCompanionAnswer}
              aria-label={t("companion.stop")}
              title={t("companion.stop")}
            >
              <Square size={14} aria-hidden />
            </button>
          ) : (
            <button
              type="submit"
              className="btn btn--primary btn--icon"
              disabled={!draft.trim()}
              aria-label={t("companion.send")}
              title={t("companion.send")}
            >
              <SendHorizontal size={14} aria-hidden />
            </button>
          )}
        </form>
      )}

      <footer className="companion__foot">
        <span>{t("companion.notSaved")}</span>
        {messages.length > 0 && !busy && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => useCompanionStore.getState().clearChat()}
          >
            {t("companion.clear")}
          </button>
        )}
      </footer>
    </section>
  );
}
