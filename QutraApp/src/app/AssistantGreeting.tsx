import { useEffect } from "react";
import { usePreferences } from "@/lib/db/database";
import { addressName, dayPart } from "@/lib/greeting";
import { ensureDeferredCopy, translate, type Locale } from "@/lib/i18n";
import { useUi } from "@/state/ui";

/* Once per app launch, when the assistant is enabled, it says hello from the
   bottom-right corner: the time of day and, if the user gave one, their form
   of address ("Günaydın, Mert Bey"). Nothing is sent anywhere; this is a
   small toast. */

let greeted = false;

/** Lets a test greet again, as a fresh launch would. */
export function resetGreetingForTesting(): void {
  greeted = false;
}

export function AssistantGreeting() {
  const prefs = usePreferences();
  const toast = useUi((s) => s.toast);
  const enabled = prefs.localAssistantEnabled;
  const locale = prefs.locale as Locale;
  const name = addressName(prefs.addressAs);

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
        toast({
          kind: "info",
          message: `${greeting}. ${translate(locale, "assistant.greet.line")}`,
        });
      });
  }, [enabled, locale, name, toast]);

  return null;
}
