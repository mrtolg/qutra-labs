import { describe, expect, it } from "vitest";
import {
  applyAppearanceAttributes,
  migrateAppearanceIntent,
  resolveAppearance,
  type AppearanceCapabilities,
} from "./appearance";
import { PreferencesSchema } from "@/domain/types";

const caps: AppearanceCapabilities = { highContrast: false, forcedColors: false };

describe("window effects are gone", () => {
  it.each(["mica", "acrylic", "liquidGlass"])(
    "reads a stored %s material as the flat window",
    (material) => {
      const r = resolveAppearance({ material, packId: "contextos" }, caps, true);
      expect(r).toEqual({
        packId: "contextos",
        themeAttr: "contextos",
        mode: "dark",
        highContrast: false,
      });
    },
  );

  it("reads the legacy windows theme as flat, keeping the stored pack", () => {
    expect(migrateAppearanceIntent({ theme: "windows", packId: "catppuccin" })).toEqual({
      packId: "catppuccin",
      highContrast: false,
    });
  });

  it("parses stored preferences with an old material and leaves it untouched", () => {
    const stored = { locale: "tr", material: "acrylic", theme: "windows", packId: "hud" };
    const prefs = PreferencesSchema.parse(stored);
    expect(prefs.locale).toBe("tr");
    expect(prefs.material).toBe("acrylic");
    expect(resolveAppearance(prefs, caps, false).themeAttr).toBe("hud");
  });

  it("clears every attribute an older version set for window effects", () => {
    const root = document.createElement("div");
    Object.assign(root.dataset, {
      requestedMaterial: "mica",
      nativeBackdrop: "mica",
      chromeTreatment: "refractive",
      windowMaterial: "mica",
      materialFallback: "effect-failed",
      reduceTransparency: "true",
    });
    applyAppearanceAttributes(root, resolveAppearance({ packId: "hud" }, caps, true));
    expect({ ...root.dataset }).toEqual({
      theme: "hud",
      pack: "hud",
      mode: "dark",
      contrast: "normal",
    });
  });
});

describe("resolveAppearance", () => {
  it("maps the hud pack to themeAttr hud", () => {
    const r = resolveAppearance({ packId: "hud" }, caps, true);
    expect(r.packId).toBe("hud");
    expect(r.themeAttr).toBe("hud");
  });

  it("keeps the contextos pack on themeAttr contextos", () => {
    const r = resolveAppearance({ packId: "contextos" }, caps, true);
    expect(r.packId).toBe("contextos");
    expect(r.themeAttr).toBe("contextos");
  });

  it("lets high contrast win over hud", () => {
    const r = resolveAppearance({ packId: "hud", highContrast: true }, caps, true);
    expect(r.packId).toBe("highContrast");
    expect(r.themeAttr).toBe("highContrast");
    expect(r.highContrast).toBe(true);
  });

  it("follows the system's forced colours", () => {
    const r = resolveAppearance(
      { packId: "catppuccin" },
      { highContrast: true, forcedColors: true },
      false,
    );
    expect(r.packId).toBe("highContrast");
  });
});
