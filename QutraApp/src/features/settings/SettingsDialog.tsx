import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Settings, X } from "lucide-react";
import { useT, withDeferredCopy } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import { AppearanceApplyBar } from "./AppearanceApplyBar";
import { useShortcutBindings } from "@/app/useShortcuts";
import { bindingKeys, keyLabel } from "@/lib/shortcuts";

const SettingsPanel = lazy(withDeferredCopy(() => import("./SettingsPanel")));

/**
 * Settings as a full-window modal over the current surface (02-SHELL-SPEC §3):
 * you adjust and return, you never "go to" Settings. Opened by the gear, its
 * shortcut and the palette through `useUi.openSettings`; Escape, Close and
 * the backdrop close it, and focus returns to whatever opened it.
 */
export function SettingsDialog() {
  const { t } = useT();
  const section = useUi((s) => s.settingsSection);
  const closeSettings = useUi((s) => s.closeSettings);
  const settingsKeys = useShortcutBindings().settings;
  const open = section !== null;
  const ref = useRef<HTMLDialogElement>(null);
  const originRef = useRef<HTMLElement | null>(null);
  // Mounted only while open: the panel and its collections stay unloaded
  // until Settings is first used.
  const [present, setPresent] = useState(open);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    originRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    setPresent(true);
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !present) return;
    if (open && !el.open) {
      el.showModal();
      // Start in the section search, the way into any setting. On the first
      // open the panel is still loading; it takes focus itself when it mounts.
      el.querySelector<HTMLElement>("#settings-search")?.focus();
    } else if (!open) {
      if (el.open) el.close();
      const origin = originRef.current;
      originRef.current = null;
      setPresent(false);
      if (origin && document.contains(origin)) origin.focus();
    }
  }, [open, present]);

  // Escape (the native `cancel` event) and a click on the backdrop close it,
  // as in the shared Dialog: the listeners sit on the element, so the dialog
  // carries no pointer-only handler. The Close button is the visible way out.
  useEffect(() => {
    const el = ref.current;
    if (!el || !present) return;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      // Escape while a shortcut is being recorded cancels the recording only.
      if (el.querySelector("[data-recording]")) return;
      closeSettings();
    };
    const handleClick = (event: MouseEvent) => {
      if (event.target === el) closeSettings();
    };
    el.addEventListener("cancel", handleCancel);
    el.addEventListener("click", handleClick);
    return () => {
      el.removeEventListener("cancel", handleCancel);
      el.removeEventListener("click", handleClick);
    };
  }, [closeSettings, present]);

  if (!present) return null;
  return createPortal(
    <dialog
      ref={ref}
      className="settings-dialog"
      aria-labelledby="settings-dialog-title"
    >
      <header className="settings-dialog-head">
        <Settings size={17} className="settings-dialog-mark" aria-hidden />
        <h2 id="settings-dialog-title" className="settings-dialog-title">
          {t("settings.title")}
        </h2>
        {settingsKeys && (
          <kbd className="kbd" aria-hidden>
            {bindingKeys(settingsKeys).map(keyLabel).join(" ")}
          </kbd>
        )}
        <span className="settings-dialog-saved">{t("settings.savedOnDevice")}</span>
        <button
          type="button"
          className="btn btn--sm settings-dialog-close"
          onClick={closeSettings}
          aria-keyshortcuts="Escape"
        >
          <X size={14} aria-hidden />
          {t("action.close")}
          <kbd className="kbd" aria-hidden>
            Esc
          </kbd>
        </button>
      </header>
      <Suspense
        fallback={<div className="settings-shell" aria-busy="true" />}
      >
        {section && <SettingsPanel section={section} />}
      </Suspense>
      <AppearanceApplyBar />
    </dialog>,
    document.body,
  );
}
