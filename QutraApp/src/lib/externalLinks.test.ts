import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn());
vi.mock("@/lib/bridge", () => ({ getBridge: () => ({ openUrl }) }));

import { installExternalLinks } from "./externalLinks";

let stop: () => void;

beforeEach(() => {
  openUrl.mockReset();
  openUrl.mockResolvedValue({ ok: true, simulated: false });
  stop = installExternalLinks();
});

afterEach(() => {
  stop();
  document.body.replaceChildren();
});

function link(href: string, target?: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = href;
  if (target) anchor.target = target;
  anchor.textContent = "link";
  document.body.appendChild(anchor);
  return anchor;
}

function click(element: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  element.dispatchEvent(event);
  return event;
}

describe("links that leave the app", () => {
  it("opens a new-window link through the bridge and keeps the window where it is", () => {
    const event = click(link("https://example.com/a?b=1", "_blank"));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a?b=1");
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens a link clicked with Ctrl or Shift the same way", () => {
    click(link("http://example.com/x"), { ctrlKey: true });
    click(link("http://example.com/y"), { shiftKey: true });
    expect(openUrl.mock.calls.map(([url]) => url)).toEqual([
      "http://example.com/x",
      "http://example.com/y",
    ]);
  });

  it("opens a link whose click lands on an element inside it", () => {
    const anchor = link("https://example.com/inner", "_blank");
    const inner = document.createElement("span");
    anchor.appendChild(inner);
    click(inner);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/inner");
  });

  it("drops an address that is not http(s) instead of navigating to it", () => {
    for (const href of [
      "javascript:alert(1)",
      "file:///C:/Windows/notepad.exe",
      "mailto:a@example.com",
      "ms-settings:privacy",
    ]) {
      const event = click(link(href, "_blank"));
      expect(event.defaultPrevented, href).toBe(true);
    }
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("leaves ordinary in-page links alone", () => {
    const event = click(link("#main"));
    expect(event.defaultPrevented).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("ignores other mouse buttons and clicks another handler already took", () => {
    const anchor = link("https://example.com/", "_blank");
    click(anchor, { button: 1 });
    anchor.addEventListener("click", (event) => event.preventDefault());
    click(anchor);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("stops listening when removed", () => {
    stop();
    click(link("https://example.com/", "_blank"));
    expect(openUrl).not.toHaveBeenCalled();
  });
});
