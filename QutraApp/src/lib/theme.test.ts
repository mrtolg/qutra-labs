import { describe, expect, it } from "vitest";
import {
  resolveTheme,
  scheduleMode,
  THEMES,
  THEME_IDS,
} from "./theme";

describe("resolveTheme", () => {
  it("maps System to Qutra Labs following the OS", () => {
    expect(resolveTheme({ theme: "system" }, true)).toEqual({
      themeId: "contextos",
      mode: "dark",
    });
    expect(resolveTheme({ theme: "system" }, false)).toEqual({
      themeId: "contextos",
      mode: "light",
    });
    // Missing/undefined behaves like system.
    expect(resolveTheme({ theme: undefined as unknown as string }, true).mode).toBe(
      "dark",
    );
  });

  it("maps legacy light/dark to Qutra Labs fixed modes", () => {
    expect(resolveTheme({ theme: "light" }, true)).toEqual({
      themeId: "contextos",
      mode: "light",
    });
    expect(resolveTheme({ theme: "dark" }, false)).toEqual({
      themeId: "contextos",
      mode: "dark",
    });
  });

  it("maps retired decorative themes to Qutra Labs", () => {
    expect(
      resolveTheme({ theme: "carbonSignal", themeMode: "dark" }, false),
    ).toEqual({ themeId: "contextos", mode: "dark" });
    expect(
      resolveTheme({ theme: "oceanPulse", themeMode: "light" }, true).mode,
    ).toBe("light");
    expect(
      resolveTheme({ theme: "liquidGlass", themeMode: "dark" }, false).themeId,
    ).toBe("contextos");
    expect(
      resolveTheme({ theme: "acrylicClear", themeMode: "light" }, true).themeId,
    ).toBe("contextos");
    expect(
      resolveTheme({ theme: "contextRose", themeMode: "system" }, true).themeId,
    ).toBe("contextos");
  });

  it("reads the retired Windows theme as Qutra Labs", () => {
    expect(resolveTheme({ theme: "windows", themeMode: "dark" }, false)).toEqual({
      themeId: "contextos",
      mode: "dark",
    });
  });

  it("follows the OS when a named theme uses system mode", () => {
    expect(
      resolveTheme({ theme: "contextos", themeMode: "system" }, true).mode,
    ).toBe("dark");
    expect(
      resolveTheme({ theme: "solarEmber", themeMode: "system" }, true).mode,
    ).toBe("dark");
    expect(
      resolveTheme({ theme: "windows", themeMode: "system" }, false).mode,
    ).toBe("light");
  });

  it("falls back to Qutra Labs for an unknown theme id", () => {
    expect(
      resolveTheme({ theme: "bogus", themeMode: "light" }, false).themeId,
    ).toBe("contextos");
  });

  it("forces High Contrast when the accessibility pref is on", () => {
    expect(
      resolveTheme({ theme: "contextos", highContrast: true }, false),
    ).toEqual({ themeId: "highContrast", mode: "light" });
    expect(
      resolveTheme({ theme: "windows", highContrast: true }, true).themeId,
    ).toBe("highContrast");
    expect(
      resolveTheme({ theme: "system", highContrast: true }, true).themeId,
    ).toBe("highContrast");
  });

  it("honors an explicit High Contrast theme pick", () => {
    expect(
      resolveTheme({ theme: "highContrast", themeMode: "dark" }, false),
    ).toEqual({ themeId: "highContrast", mode: "dark" });
  });
});

describe("scheduleMode", () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);

  it("uses the evening→morning dark window", () => {
    expect(scheduleMode(at(22), "07:00", "19:00")).toBe("dark");
    expect(scheduleMode(at(3), "07:00", "19:00")).toBe("dark");
    expect(scheduleMode(at(12), "07:00", "19:00")).toBe("light");
    expect(scheduleMode(at(7), "07:00", "19:00")).toBe("light");
    expect(scheduleMode(at(19), "07:00", "19:00")).toBe("dark");
  });

  it("handles a daytime dark window (dark after light)", () => {
    // dark 09:00..17:00
    expect(scheduleMode(at(12), "17:00", "09:00")).toBe("dark");
    expect(scheduleMode(at(20), "17:00", "09:00")).toBe("light");
  });

  it("defaults gracefully on malformed times", () => {
    expect(["light", "dark"]).toContain(scheduleMode(at(12), "bad", "nope"));
  });
});

describe("theme registry", () => {
  it("exposes Qutra Labs and High Contrast", () => {
    expect(THEME_IDS).toEqual(["contextos", "highContrast"]);
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
    for (const meta of THEMES) {
      expect(meta.nameKey).toMatch(/^theme\./);
      expect(meta.descKey).toMatch(/^theme\..*\.desc$/);
    }
  });
});
