import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="empty">
      <Icon size={28} strokeWidth={1.5} aria-hidden />
      <h2 className="empty-title">{title}</h2>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}
