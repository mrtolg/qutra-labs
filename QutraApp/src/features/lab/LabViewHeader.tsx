import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * What a Lab view is for, said once at its top so that opening it never
 * leaves the question of what to do next: the view's name, one sentence of
 * purpose and, when there is one, the action the view exists for.
 */
export function LabViewHeader({
  icon: Icon,
  title,
  purpose,
  action,
  id,
}: {
  icon: LucideIcon;
  title: string;
  purpose: string;
  action?: ReactNode;
  /** For a region that names itself by this heading. */
  id?: string;
}) {
  return (
    <header className="lab-vh">
      <span className="lab-vh__icon" aria-hidden>
        <Icon size={17} />
      </span>
      <div className="lab-vh__text">
        <h2 id={id} className="lab-vh__title">
          {title}
        </h2>
        <p className="lab-vh__purpose">{purpose}</p>
      </div>
      {action && <div className="lab-vh__action">{action}</div>}
    </header>
  );
}

/** A view with nothing in it yet: what goes here and how to get it there. */
export function LabEmpty({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <div className="lab-empty">
      <span className="lab-empty__icon" aria-hidden>
        <Icon size={22} />
      </span>
      <h3 className="lab-empty__title">{title}</h3>
      <p className="lab-empty__hint">{hint}</p>
      {action && <div className="lab-empty__action">{action}</div>}
    </div>
  );
}
