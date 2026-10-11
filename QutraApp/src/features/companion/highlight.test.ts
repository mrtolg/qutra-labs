import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIGHLIGHT_MS, clearHighlight, findGuideTarget, highlightGuideTarget } from "./highlight";

/* "Bana göster": an outline on the element a guide step names, and the
   element scrolled into view. Nothing is clicked. */

let scrollIntoView: ReturnType<typeof vi.fn>;

function page(html: string) {
  document.body.innerHTML = html;
}

beforeEach(() => {
  vi.useFakeTimers();
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
  delete document.documentElement.dataset.reduceMotion;
});

afterEach(() => {
  clearHighlight();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("highlightGuideTarget", () => {
  it("outlines the named element, scrolls it into view and leaves it unclicked", () => {
    const onClick = vi.fn();
    page('<button data-guide="lab-new">New</button>');
    const button = document.querySelector<HTMLButtonElement>("[data-guide]")!;
    button.addEventListener("click", onClick);

    expect(highlightGuideTarget("lab-new")).toBe(true);

    expect(button).toHaveAttribute("data-guide-hit", "true");
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
      behavior: "smooth",
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("takes the outline away after a few seconds", () => {
    page('<button data-guide="search">Search</button>');
    const button = document.querySelector("button")!;
    highlightGuideTarget("search");
    vi.advanceTimersByTime(HIGHLIGHT_MS - 1);
    expect(button).toHaveAttribute("data-guide-hit");
    vi.advanceTimersByTime(2);
    expect(button).not.toHaveAttribute("data-guide-hit");
  });

  it("moves the outline when another element is pointed at", () => {
    page('<button data-guide="a">A</button><button data-guide="b">B</button>');
    const [a, b] = document.querySelectorAll("button");
    highlightGuideTarget("a");
    highlightGuideTarget("b");
    expect(a).not.toHaveAttribute("data-guide-hit");
    expect(b).toHaveAttribute("data-guide-hit");
  });

  it("scrolls without animation under reduced motion", () => {
    document.documentElement.dataset.reduceMotion = "true";
    page('<button data-guide="settings">S</button>');
    highlightGuideTarget("settings");
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
  });

  it("says no when the element is not on screen", () => {
    page("<p>nothing here</p>");
    expect(highlightGuideTarget("lab-new")).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not point into a page that is kept alive but hidden, or behind a modal", () => {
    page(
      '<div hidden><button data-guide="terminal-new">x</button></div>' +
        '<div inert><button data-guide="terminal-new">y</button></div>',
    );
    expect(findGuideTarget("terminal-new")).toBeNull();
    expect(highlightGuideTarget("terminal-new")).toBe(false);
  });

  it("takes a name only in the form the app writes, never a selector", () => {
    page('<button data-guide="a">A</button>');
    expect(findGuideTarget('a"], body, [x="')).toBeNull();
    expect(findGuideTarget("")).toBeNull();
    expect(findGuideTarget("A")).toBeNull();
  });
});
