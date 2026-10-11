/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- The focusable WAI-ARIA separator is a keyboard-operable resize widget. */
import { useRef } from "react";

/** Draggable resize handle shared by the inspector and bottom panel. */
export function ResizeHandle({
  orientation,
  onResize,
  onCommit,
  ariaLabel,
  value,
  min,
  max,
}: {
  orientation: "x" | "y";
  /** Fires on every movement — update transient layout state only. */
  onResize: (deltaPx: number) => void;
  /**
   * Fires once the gesture ends. Persist here, not in `onResize`.
   *
   * A drag emits a pointermove per frame, and each one used to write the whole
   * Preferences blob. On desktop that is a serialized SQLite write per frame,
   * so a single slow drag could queue hundreds of writes for a value the user
   * only meant to set once.
   */
  onCommit?: () => void;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
}) {
  const start = useRef(0);
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = orientation === "x" ? e.clientX : e.clientY;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!(e.target as HTMLElement).hasPointerCapture?.(e.pointerId)) return;
    const pos = orientation === "x" ? e.clientX : e.clientY;
    const delta = pos - start.current;
    if (delta !== 0) {
      onResize(delta);
      start.current = pos;
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    onCommit?.();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const delta =
      orientation === "x"
        ? e.key === "ArrowLeft"
          ? -8
          : e.key === "ArrowRight"
            ? 8
            : 0
        : e.key === "ArrowUp"
          ? -8
          : e.key === "ArrowDown"
            ? 8
            : 0;
    if (delta === 0) return;
    e.preventDefault();
    onResize(delta);
    // A key press is one deliberate adjustment, so it persists immediately
    // rather than waiting for a gesture that will never end.
    onCommit?.();
  };
  return (
    <div
      className={`resize-handle resize-handle--${orientation}`}
      role="separator"
      tabIndex={0}
      aria-orientation={orientation === "x" ? "vertical" : "horizontal"}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
