import { useLayoutEffect, useRef, useState } from "react";

export interface GlideThumb {
  x: number;
  width: number;
}

/**
 * One highlight that glides to the current item of a row: the measured
 * position of the child matching `current` (`aria-current="page"` for
 * navigation, `aria-selected="true"` for tabs). Labels change width with the
 * language and the font, so it re-measures whenever `key` changes and
 * whenever the row resizes. Shared by the top bar, the row under it and the
 * in-page tab strips.
 */
export function useGlideThumb<T extends HTMLElement>(
  key: string,
  current = '[aria-current="page"]',
) {
  const ref = useRef<T>(null);
  const [thumb, setThumb] = useState<GlideThumb | null>(null);

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const place = () => {
      const active = host.querySelector<HTMLElement>(current);
      const next = active ? { x: active.offsetLeft, width: active.offsetWidth } : null;
      setThumb((prev) =>
        prev && next && prev.x === next.x && prev.width === next.width ? prev : next,
      );
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(host);
    return () => observer.disconnect();
  }, [key, current]);

  return { ref, thumb };
}
