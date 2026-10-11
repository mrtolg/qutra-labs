import { scrollBehavior } from "@/lib/motion";

/* "Bana göster": point at an element of the app. The element carries a
   `data-guide` name (a token the app wrote, never user text); pointing sets
   `data-guide-hit` on it, which companion.css turns into an outline and a
   short pulse, and scrolls it into view. Nothing is clicked or changed. */

/** How long the outline stays. */
export const HIGHLIGHT_MS = 3_500;

const NAME = /^[a-z0-9-]{1,40}$/;

let release: (() => void) | null = null;

/** The first element with this guide name that is on screen: not in a page
    that is kept alive but hidden, and not behind a modal. */
export function findGuideTarget(name: string): HTMLElement | null {
  if (!NAME.test(name)) return null;
  for (const el of document.querySelectorAll<HTMLElement>(`[data-guide="${name}"]`)) {
    if (!el.closest("[hidden], [inert]")) return el;
  }
  return null;
}

/** Remove the outline now. */
export function clearHighlight(): void {
  release?.();
}

/**
 * Outline the element and bring it into view. Returns false when it is not
 * on screen right now, so the caller can say so instead of doing nothing.
 */
export function highlightGuideTarget(name: string): boolean {
  const el = findGuideTarget(name);
  if (!el) return false;
  clearHighlight();
  el.setAttribute("data-guide-hit", "true");
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: scrollBehavior() });
  const timer = setTimeout(clearHighlight, HIGHLIGHT_MS);
  release = () => {
    clearTimeout(timer);
    el.removeAttribute("data-guide-hit");
    release = null;
  };
  return true;
}
