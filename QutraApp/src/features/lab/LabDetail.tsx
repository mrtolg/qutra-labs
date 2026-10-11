import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { X } from "lucide-react";
import { useT } from "@/lib/i18n";

/**
 * The record open inside a Lab view (`?item=<id>`). Deep-linkable, and the
 * view switcher drops it, so a detail never outlives its view (details
 * stay in Lab's own views, not in the context panel).
 */
export function useLabItem() {
  const [params, setParams] = useSearchParams();
  const item = params.get("item");
  const open = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set("item", id);
      setParams(next);
    },
    [params, setParams],
  );
  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete("item");
    setParams(next);
  }, [params, setParams]);
  return { item, open, close };
}

/** A view's list beside the open record's detail. */
export function LabSplit({ detail, children }: { detail: ReactNode; children: ReactNode }) {
  return (
    <div className={detail ? "lab-split" : "lab-split lab-split--single"}>
      <div className="lab-split__list">{children}</div>
      {detail}
    </div>
  );
}

export function LabDetail({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  /** The record's own name, when the body does not already lead with it. */
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useT();
  const ref = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Focus moves into the detail when it opens and back where it came from.
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (restoreRef.current?.isConnected) restoreRef.current.focus();
    };
  }, []);

  return (
    // Escape closes the detail it is inside of; focus is placed here on open.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      ref={ref}
      className="lab-record"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="lab-record__h">
        <div className="lab-record__names">
          <h2 className="lab-record__t">{title}</h2>
          {subtitle && <p className="lab-record__s">{subtitle}</p>}
        </div>
        <button
          type="button"
          className="btn btn--icon btn--sm"
          onClick={onClose}
          aria-label={t("action.close")}
        >
          <X size={14} aria-hidden />
        </button>
      </header>
      <div className="lab-record__b">{children}</div>
    </section>
  );
}
