import { useEffect, type RefObject } from "react";

/** Closes a `<details>` popover like a menu: a click elsewhere or Escape. */
export function useDetailsDismiss(ref: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (e.key === "Escape" && el?.open) {
        el.open = false;
        el.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref]);
}
