import { useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { useT } from "@/lib/i18n";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  /** Require typing this exact word (e.g. DELETE) to enable confirm. */
  typeToConfirm?: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  typeToConfirm,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const { t } = useT();
  const [typed, setTyped] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const blocked = !!typeToConfirm && typed !== typeToConfirm;

  return (
    <Dialog
      open={open}
      onClose={() => {
        setTyped("");
        onClose();
      }}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t("action.cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${danger ? "btn--danger" : "btn--primary"}`}
            disabled={blocked}
            onClick={() => {
              setTyped("");
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ maxWidth: "52ch" }}>{body}</p>
      {typeToConfirm && (
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="confirm-word">{typeToConfirm}</label>
          <input
            id="confirm-word"
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
    </Dialog>
  );
}
