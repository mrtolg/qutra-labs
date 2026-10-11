import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollBehavior } from "./motion";

function mockQuery(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: reduce && query.includes("reduce"), media: query })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.reduceMotion;
});

describe("scrollBehavior", () => {
  it("scrolls smoothly when neither switch asks for less motion", () => {
    mockQuery(false);
    expect(scrollBehavior()).toBe("smooth");
  });

  it("jumps when the app's Reduce motion setting is on", () => {
    mockQuery(false);
    document.documentElement.dataset.reduceMotion = "true";
    expect(scrollBehavior()).toBe("auto");
  });

  it("jumps when the OS asks for reduced motion", () => {
    mockQuery(true);
    document.documentElement.dataset.reduceMotion = "false";
    expect(scrollBehavior()).toBe("auto");
  });
});
