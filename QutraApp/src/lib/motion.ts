/* Reduced motion for scripts. CSS `scroll-behavior` does not reach a
   scrollIntoView that names its own behaviour, so scripted scrolls ask here: the
   app's own "Reduce motion" setting (AppShell sets data-reduce-motion on
   <html>) and the OS query both turn smooth scrolling off. */

export function prefersReducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.reduceMotion === "true") {
    return true;
  }
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
