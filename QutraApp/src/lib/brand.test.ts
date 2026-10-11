import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const runtime = vi.hoisted(() => ({ tauri: false }));
vi.mock("@/lib/runtime", () => ({ isTauriRuntime: () => runtime.tauri }));

import { applyBrandWindowIcon, brandVariant } from "./brand";

afterEach(() => {
  invoke.mockReset();
  runtime.tauri = false;
});

describe("brand variant", () => {
  it("is cyan only in hud dark without high contrast", () => {
    expect(brandVariant({ themeAttr: "hud", mode: "dark", highContrast: false })).toBe("cyan");
    expect(brandVariant({ themeAttr: "hud", mode: "light", highContrast: false })).toBe("red");
    expect(brandVariant({ themeAttr: "catppuccin", mode: "dark", highContrast: false })).toBe("red");
    expect(brandVariant({ themeAttr: "highContrast", mode: "dark", highContrast: true })).toBe("red");
    expect(brandVariant({ themeAttr: "hud", mode: "dark", highContrast: true })).toBe("red");
  });

  it("uses the same rule as the top bar's CSS", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src/styles/app.css"), "utf8");
    expect(css).toContain(
      '[data-theme="hud"][data-mode="dark"]:not([data-contrast="high"]) .topbar-home .logo-mark--cyan',
    );
  });

  it("never reaches for a native call in the browser", async () => {
    await applyBrandWindowIcon("red");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("names a variant to Rust, once per change", async () => {
    runtime.tauri = true;
    await applyBrandWindowIcon("red");
    await applyBrandWindowIcon("red");
    await applyBrandWindowIcon("cyan");
    expect(invoke.mock.calls).toEqual([
      ["set_brand_window_icon", { variant: "red" }],
      ["set_brand_window_icon", { variant: "cyan" }],
    ]);
  });
});
