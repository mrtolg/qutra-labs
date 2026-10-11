import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** A segment with nothing to show says why, and offers one next step. */
export function ContextEmpty({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ctx-empty">
      <span className="ctx-ricon" aria-hidden>
        <Icon size={16} />
      </span>
      <h3 className="ctx-empty__t">{title}</h3>
      <p className="ctx-empty__h">{hint}</p>
      {action}
    </div>
  );
}
