import { CheckCircle2, Info, AlertTriangle, X } from "lucide-react";
import { useUi } from "@/state/ui";
import { useT } from "@/lib/i18n";

/** Toast + status region. Never steals keyboard focus (aria-live only). */
export function Toasts() {
  const { toasts, dismissToast, liveMessage } = useUi();
  const { t } = useT();

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </div>
      <div className="toast-region">
        {toasts.map((toast) => {
          const Icon =
            toast.kind === "success"
              ? CheckCircle2
              : toast.kind === "danger"
                ? AlertTriangle
                : Info;
          const text = toast.messageKey
            ? t(toast.messageKey, toast.params)
            : (toast.message ?? "");
          return (
            <div
              key={toast.id}
              className={`toast toast--${toast.kind}`}
              role={toast.kind === "danger" ? "alert" : "status"}
              aria-live={toast.kind === "danger" ? "assertive" : "polite"}
              aria-atomic="true"
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
              <span style={{ flex: 1 }}>{text}</span>
              {toast.onAction && toast.actionKey && (
                <button
                  type="button"
                  className="btn btn--sm btn--secondary"
                  onClick={() => {
                    toast.onAction?.();
                    dismissToast(toast.id);
                  }}
                >
                  {t(toast.actionKey)}
                </button>
              )}
              <button
                type="button"
                className="btn btn--icon btn--sm"
                aria-label={`${t("action.close")}: ${text}`}
                onClick={() => dismissToast(toast.id)}
              >
                <X size={13} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
