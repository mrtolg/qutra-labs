import { useId, type CSSProperties, type ReactNode } from "react";

/** A form control with a label the user can see. aria-label and placeholders
    are invisible or vanish while typing, so every input gets one of these
    The id is generated, so the same panel can render
    twice on a page without two controls sharing a label. */
export function Field({
  label,
  children,
  className,
  style,
}: {
  label: ReactNode;
  children: (id: string) => ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const id = useId();
  return (
    <div className={className ? `field ${className}` : "field"} style={style}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}
