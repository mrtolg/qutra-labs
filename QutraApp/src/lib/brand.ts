/* The brand mark takes the theme's identity colour: the
   cyan Q in hud dark, the red Q in every other pack and every light mode, and
   red in high contrast (flat there; the glow is CSS). The top bar picks its
   mark in app.css with the same rule; this module picks the window and
   taskbar icon, which only Rust can set. */

import { isTauriRuntime } from "@/lib/runtime";
import type { ResolvedAppearance } from "@/lib/appearance";

export type BrandVariant = "cyan" | "red";

export function brandVariant(
  resolved: Pick<ResolvedAppearance, "themeAttr" | "mode" | "highContrast">,
): BrandVariant {
  return resolved.themeAttr === "hud" && resolved.mode === "dark" && !resolved.highContrast
    ? "cyan"
    : "red";
}

let applied: BrandVariant | null = null;

/** Ask Rust to show one of the two bundled window icons. The renderer names a
 *  variant only; Rust owns the image bytes. A no-op in the browser. */
export async function applyBrandWindowIcon(variant: BrandVariant): Promise<void> {
  if (!isTauriRuntime() || applied === variant) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_brand_window_icon", { variant });
    applied = variant;
  } catch (error) {
    // Cosmetic: the exe's own (cyan) icon stays. Say so, do not pretend.
    console.warn("window icon not changed", error);
  }
}
