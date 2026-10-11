import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** A section that opens on request. Its title says what is inside and its
    summary what state that is in, so the closed form still tells the user
    whether they need to open it. */
export function LabDisclosure({
  title,
  summary,
  defaultOpen = false,
  tone,
  children,
}: {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** "warning" draws it as something to look at. */
  tone?: "warning";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section
      className={`lab-disc${open ? " is-open" : ""}${tone ? ` lab-disc--${tone}` : ""}`}
    >
      <h4 className="lab-disc__h">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight size={15} aria-hidden className="lab-disc__chev" />
          <span className="lab-disc__title">{title}</span>
          {summary && <span className="lab-disc__sum">{summary}</span>}
        </button>
      </h4>
      {/* Rendered only while open: nothing folded away is in the page. */}
      <div id={id} className="lab-disc__body" hidden={!open}>
        {open && children}
      </div>
    </section>
  );
}
