import { useEffect, useState } from "react";
import { CheckCircle2, Info, AlertTriangle, X } from "lucide-react";
import { useUi, type Toast } from "@/state/ui";
import { useT } from "@/lib/i18n";

/** Toast + status region. Never steals keyboard focus (aria-live only). */
export function Toasts() {
  const toasts = useUi((state) => state.toasts);
  const liveMessage = useUi((state) => state.liveMessage);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </div>
      <div className="toast-region">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
    </>
  );
}

/** One toast. Its countdown holds while the pointer is over it or focus is
    inside it, so an Undo can be reached without racing the clock. */
function ToastItem({ toast }: { toast: Toast }) {
  const { t } = useT();
  const dismissToast = useUi((state) => state.dismissToast);
  const pauseToast = useUi((state) => state.pauseToast);
  const resumeToast = useUi((state) => state.resumeToast);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const { id } = toast;

  useEffect(() => {
    if (!held) return;
    pauseToast(id);
    return () => resumeToast(id);
  }, [held, id, pauseToast, resumeToast]);

  const Icon =
    toast.kind === "success" ? CheckCircle2 : toast.kind === "danger" ? AlertTriangle : Info;
  const text = toast.messageKey ? t(toast.messageKey, toast.params) : (toast.message ?? "");
  return (
    <div
      className={`toast toast--${toast.kind}`}
      role={toast.kind === "danger" ? "alert" : "status"}
      aria-live={toast.kind === "danger" ? "assertive" : "polite"}
      aria-atomic="true"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <Icon
        size={15}
        aria-hidden
        style={{
          color:
            toast.kind === "success"
              ? "var(--success)"
              : toast.kind === "danger"
                ? "var(--danger)"
                : "var(--info)",
          flex: "none",
          marginTop: 2,
        }}
      />
      <span style={{ flex: 1 }}>
        {text}
        {(toast.count ?? 1) > 1 && (
          <span className="toast__count" data-testid="toast-count">
            {" "}
            ×{toast.count}
          </span>
        )}
      </span>
      {toast.onAction && toast.actionKey && (
        <button
          type="button"
          className="btn btn--sm btn--secondary"
          onClick={() => {
            toast.onAction?.();
            dismissToast(id);
          }}
        >
          {t(toast.actionKey)}
        </button>
      )}
      <button
        type="button"
        className="btn btn--icon btn--sm"
        aria-label={`${t("action.close")}: ${text}`}
        onClick={() => dismissToast(id)}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}
