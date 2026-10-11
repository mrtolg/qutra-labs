import { getBridge } from "@/lib/bridge";
import { isTauriRuntime } from "@/lib/runtime";

/**
 * A link that asks for a new window (`target="_blank"`, or a click with Ctrl
 * or Shift) opens in the user's browser through the bridge, which hands the
 * address to the Rust command that accepts http(s) only. The window holds no
 * permission to open an address itself, so this is the one way a link leaves
 * the app. Any other address on such a link is dropped, never navigated to.
 */
export function installExternalLinks(root: Document = document): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey) return;
    const anchor = event
      .composedPath()
      .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    if (!anchor?.href) return;
    if (anchor.target !== "_blank" && !event.ctrlKey && !event.shiftKey) return;
    event.preventDefault();
    let url: URL;
    try {
      url = new URL(anchor.href);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    void getBridge().openUrl(url.href);
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}

/** The desktop app only: a browser opens its own links. */
export function installExternalLinksForDesktop(): () => void {
  return isTauriRuntime() ? installExternalLinks() : () => undefined;
}
