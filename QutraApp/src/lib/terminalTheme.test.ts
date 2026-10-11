import { describe, expect, it } from "vitest";
import { oklchTokenToHex, themeFromCssValues } from "./terminalTheme";

describe("oklchTokenToHex", () => {
  it("emits #rrggbb for opaque tokens", () => {
    expect(oklchTokenToHex("oklch(0 0 0)")).toBe("#000000");
    expect(oklchTokenToHex("oklch(1 0 0)")).toBe("#ffffff");
  });

  it("keeps alpha as #rrggbbaa", () => {
    const hex = oklchTokenToHex("oklch(0.802 0.126 201.4 / 0.22)");
    expect(hex).toMatch(/^#[0-9a-f]{8}$/);
    expect(hex?.slice(-2)).toBe("38"); // 0.22 * 255 ≈ 56 = 0x38
  });

  it("rejects non-oklch values", () => {
    expect(oklchTokenToHex("#060a10")).toBeNull();
    expect(oklchTokenToHex("rgb(6, 10, 16)")).toBeNull();
  });
});

describe("themeFromCssValues", () => {
  it("maps HUD tokens onto an xterm theme, falling back to --surface-sunken", () => {
    const withTerminalBg = themeFromCssValues({
      "--terminal-bg": "oklch(0.143 0.015 255.2)",
      "--ink": "oklch(0.956 0.011 226.0)",
      "--primary": "oklch(0.802 0.126 201.4)",
      "--selection-bg": "oklch(0.802 0.126 201.4 / 0.22)",
    });
    expect(withTerminalBg).not.toBeNull();
    expect(withTerminalBg!.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(withTerminalBg!.foreground).toMatch(/^#[0-9a-f]{6}$/);
    expect(withTerminalBg!.cursor).toMatch(/^#[0-9a-f]{6}$/);
    expect(withTerminalBg!.selectionBackground).toMatch(/^#[0-9a-f]{8}$/);

    const fallback = themeFromCssValues({
      "--surface-sunken": "oklch(0.148 0.015 256.7)",
      "--ink": "oklch(0.956 0.011 226.0)",
      "--primary": "oklch(0.802 0.126 201.4)",
      "--selection-bg": "oklch(0.802 0.126 201.4 / 0.22)",
    });
    expect(fallback?.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(fallback?.background).not.toBe(withTerminalBg!.background);
  });

  it("returns null when a required token is missing", () => {
    expect(themeFromCssValues({ "--ink": "oklch(1 0 0)" })).toBeNull();
  });
});
