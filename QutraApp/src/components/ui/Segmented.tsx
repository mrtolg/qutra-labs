import type { ReactNode } from "react";

interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
}

interface SegmentedProps<V extends string> {
  value: V;
  options: SegmentedOption<V>[];
  onChange: (value: V) => void;
  ariaLabel: string;
}

export function Segmented<V extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: SegmentedProps<V>) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}
