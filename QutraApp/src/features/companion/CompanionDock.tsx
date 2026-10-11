import { useRef } from "react";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import type { AppState } from "./appState";
import { MiniChat } from "./MiniChat";
import { hideCompanionOn, showCompanionOn } from "./preferences";
import { useCompanionStore } from "./store";

/** The bubble, bottom-left, and the mini chat above it while it is open.
    Bottom-left keeps clear of the toasts and the greeting at the right. */
export function CompanionDock({ state }: { state: AppState }) {
  const { t } = useT();
  const open = useCompanionStore((s) => s.open);
  const busy = useCompanionStore((s) => s.busy);
  const toast = useUi((s) => s.toast);
  const bubbleRef = useRef<HTMLButtonElement>(null);

  const setOpen = useCompanionStore.getState().setOpen;
  const close = () => {
    setOpen(false);
    bubbleRef.current?.focus();
  };
  const hide = () => {
    const key = hideCompanionOn(state.page);
    setOpen(false);
    toast({
      kind: "info",
      messageKey: "companion.hidden",
      actionKey: "companion.showAgain",
      onAction: () => showCompanionOn(key),
    });
  };

  return (
    <div className="companion" data-testid="companion">
      {open && <MiniChat key={state.page} state={state} onClose={close} onHide={hide} />}
      <button
        ref={bubbleRef}
        type="button"
        className="companion__bubble"
        aria-expanded={open}
        aria-label={t("companion.bubble")}
        title={t("companion.bubble")}
        data-busy={busy || undefined}
        data-testid="companion-bubble"
        onClick={() => setOpen(!open)}
      >
        {/* Both marks ship; companion.css shows the one the theme owns. */}
        <img className="companion__mark companion__mark--red" src="/brand/q-mark.svg" alt="" aria-hidden />
        <img className="companion__mark companion__mark--cyan" src="/brand/q-mark-cyan.svg" alt="" aria-hidden />
      </button>
    </div>
  );
}
