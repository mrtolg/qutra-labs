import { describe, expect, it } from "vitest";
import {
  parseOklch,
  oklchToRgb,
  contrastRatio,
  oklchContrast,
} from "./color";

describe("parseOklch", () => {
  it("parses L C H with optional percent and alpha", () => {
    expect(parseOklch("oklch(0.45 0.15 330)")).toEqual({ l: 0.45, c: 0.15, h: 330, alpha: 1 });
    expect(parseOklch("oklch(97.5% 0.004 330)")?.l).toBeCloseTo(0.975);
    expect(parseOklch("oklch(0.68 0.17 330 / 0.14)")?.alpha).toBeCloseTo(0.14);
    expect(parseOklch("rgb(0,0,0)")).toBeNull();
  });
});

describe("oklchToRgb anchors", () => {
  it("maps pure white and black correctly", () => {
    const white = oklchToRgb(1, 0, 0);
    expect(white).toEqual({ r: 255, g: 255, b: 255 });
    const black = oklchToRgb(0, 0, 0);
    expect(black).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe("contrast", () => {
  it("black on white is 21:1", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 0);
  });

  it("computes oklch contrast and ignores alpha colors", () => {
    const ratio = oklchContrast("oklch(0.2 0.018 330)", "oklch(1 0 0)");
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThan(4.5);
    // Alpha color → unknown background, returns null instead of guessing.
    expect(oklchContrast("oklch(0.2 0 0)", "oklch(0.45 0.15 330 / 0.09)")).toBeNull();
  });
});
