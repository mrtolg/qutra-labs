import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useT } from "@/lib/i18n";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Block Escape/backdrop close while a destructive operation runs. */
  preventClose?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

function restoreFocus(trigger: HTMLElement | null) {
  if (!trigger || !document.contains(trigger)) return;
  try {
    trigger.focus();
  } catch {
    /* Element may no longer accept focus. */
  }
}

/**
 * Native <dialog>-based modal: top-layer rendering (never clipped),
 * built-in focus containment, Escape handling, backdrop.
 * Focus returns to the opener when the dialog finishes closing.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  preventClose,
  initialFocusRef,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // Stay mounted through close() so focus return can run; do not unmount on
  // open=false alone (that left focus on document.body).
  const [present, setPresent] = useState(open);
  const { t } = useT();

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      triggerRef.current = active;
    }
    setPresent(true);
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !present) return;

    if (open && !el.open) {
      el.showModal();
      if (initialFocusRef?.current) initialFocusRef.current.focus();
      return;
    }

    if (!open) {
      if (el.open) el.close();
      // Restore here rather than only on the `close` event: when `open` flips,
      // React runs the previous listeners' cleanup before this effect, so a
      // `close` handler registered in another effect can miss the event.
      restoreFocus(triggerRef.current);
      setPresent(false);
    }
  }, [open, present, initialFocusRef]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !present) return;
    const handleCancel = (e: Event) => {
      e.preventDefault();
      if (!preventClose) onClose();
    };
    const handleClick = (e: MouseEvent) => {
      if (e.target === el && !preventClose) onClose();
    };
    el.addEventListener("cancel", handleCancel);
    el.addEventListener("click", handleClick);
    return () => {
      el.removeEventListener("cancel", handleCancel);
      el.removeEventListener("click", handleClick);
    };
  }, [onClose, preventClose, present]);

  if (!present) return null;

  return createPortal(
    <dialog
      ref={ref}
      className={`dialog${wide ? " dialog--wide" : ""}`}
      aria-labelledby="dialog-title"
    >
      <div className="dialog-header">
        <h2 className="dialog-title" id="dialog-title">
          {title}
        </h2>
        <button
          type="button"
          className="btn btn--icon btn--sm"
          onClick={onClose}
          disabled={preventClose}
          aria-label={t("action.close")}
        >
          <X size={15} aria-hidden />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-footer">{footer}</div>}
    </dialog>,
    document.body,
  );
}
