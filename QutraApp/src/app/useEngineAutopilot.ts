import { useEffect, useRef } from "react";
import { usePreferences } from "@/lib/db/database";
import { ensureLocalEngine, useAutoEngine } from "@/lib/localEngine/autoEngine";
import { useUi } from "@/state/ui";

/* The local engine takes care of itself. When the app opens with the
   assistant on and a local model as its route, the engine starts with that
   model if it is already in place. When the user then picks a local model or
   switches the assistant on, whatever is missing is fetched, prepared and
   started (src/lib/localEngine/autoEngine.ts). A failure is said once, in a
   toast; the engine strip in Settings › AI providers has the reason. */
export function useEngineAutopilot(): void {
  const prefs = usePreferences();
  const toast = useUi((s) => s.toast);
  const enabled = prefs.localAssistantEnabled;
  const model = prefs.ollamaModel;
  const local = prefs.aiProvider === "ollama";
  const previous = useRef<{ enabled: boolean; model: string } | null>(null);
  const localRoute = useRef(local);
  localRoute.current = local;

  useEffect(() => {
    const before = previous.current;
    previous.current = { enabled, model };
    if (!enabled) return;
    if (!before) {
      // The app just opened.
      if (localRoute.current) void ensureLocalEngine(model, { explicit: false });
      return;
    }
    if (!before.enabled || before.model !== model) {
      void ensureLocalEngine(model, { explicit: true });
    }
  }, [enabled, model]);

  const error = useAutoEngine((s) => (s.phase === "failed" ? s.error : null));
  useEffect(() => {
    if (error) toast({ kind: "danger", messageKey: "engine.auto.failed" });
  }, [error, toast]);
}
