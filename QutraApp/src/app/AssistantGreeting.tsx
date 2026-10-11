import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { usePreferences } from "@/lib/db/database";
import { addressName, dayPart } from "@/lib/greeting";
import { ensureDeferredCopy, translate, useT, type Locale } from "@/lib/i18n";
import "./assistantCards.css";

/* Once per app launch, when the assistant is enabled, it says hello from the
   bottom-right corner: the time of day and, if the user gave one, their form
   of address ("Günaydın, Mert Bey"). The card stays about ten seconds, waits
   while the pointer or the keyboard is on it, and closes on request. Nothing
   is sent anywhere. */

/** How long the greeting stays when nobody touches it. */
export const GREETING_MS = 10_000;

let greeted = false;

/** Lets a test greet again, as a fresh launch would. */
export function resetGreetingForTesting(): void {
  greeted = false;
}

export function AssistantGreeting() {
  const { t } = useT();
  const prefs = usePreferences();
  const enabled = prefs.localAssistantEnabled;
  const locale = prefs.locale as Locale;
  const name = addressName(prefs.addressAs);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || greeted) return;
    greeted = true;
    // The greeting's words load right after the first paint.
    void ensureDeferredCopy(locale)
      .catch(() => undefined)
      .then(() => {
        const hello = translate(locale, `assistant.greet.${dayPart(new Date().getHours())}`);
        const greeting = name
          ? translate(locale, "assistant.greet.withName", { greeting: hello, name })
          : hello;
        setMessage(`${greeting}. ${translate(locale, "assistant.greet.line")}`);
      });
  }, [enabled, locale, name]);

  // The time left runs only while nothing holds the card.
  const [held, setHeld] = useState(false);
  const left = useRef(GREETING_MS);
  useEffect(() => {
    if (message === null || held) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => setMessage(null), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - startedAt));
    };
  }, [message, held]);

  if (message === null) return null;
  return (
    <div
      className="acard acard--greeting"
      role="status"
      aria-live="polite"
      data-testid="assistant-greeting"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="acard__text">{message}</span>
      <button
        type="button"
        className="btn btn--icon btn--sm"
        aria-label={`${t("action.close")}: ${message}`}
        onClick={() => setMessage(null)}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}
