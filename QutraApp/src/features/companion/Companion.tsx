import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePreferences } from "@/lib/db/database";
import { useAppState } from "./appState";
import { CompanionDock } from "./CompanionDock";
import { clearHighlight } from "./highlight";
import { stopCompanionAnswer } from "./askCompanion";
import { companionVisibleOn } from "./preferences";
import "./companion.css";

/** While Settings is open its modal dialog makes the rest of the page inert,
    so the bubble moves inside it and stays usable. */
function useSettingsHost(open: boolean): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) {
      setHost(null);
      return;
    }
    let frame = 0;
    let tries = 0;
    const find = () => {
      const dialog = document.querySelector<HTMLElement>("dialog.settings-dialog[open]");
      if (dialog) setHost(dialog);
      else if (tries++ < 30) frame = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return open ? host : null;
}

/**
 * The "Beni takip et" companion (mounted by AppShell while the preference is
 * on, in its own chunk). Inside Qutra Labs only: it knows the page and the
 * few facts appState.ts lists, and reads nothing from the screen.
 */
export default function Companion() {
  const prefs = usePreferences();
  const state = useAppState();
  const host = useSettingsHost(state.settingsSection !== undefined);

  // An outline belongs to the page it was drawn on.
  useEffect(() => {
    clearHighlight();
  }, [state.page]);
  // Turning the companion off ends an answer still being written.
  useEffect(
    () => () => {
      stopCompanionAnswer();
      clearHighlight();
    },
    [],
  );

  if (!companionVisibleOn(prefs, state.page)) return null;
  const dock = <CompanionDock state={state} />;
  return host ? createPortal(dock, host) : dock;
}
