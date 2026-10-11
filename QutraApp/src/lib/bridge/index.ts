import type { DesktopBridge } from "./types";
import { BrowserBridge } from "./browserBridge";
import { detectRuntime, isTauriRuntime } from "@/lib/runtime";

/**
 * Bridge selection is driven by the single runtime detector (src/lib/runtime),
 * the same signal that picks the storage backend — so a native window can
 * never end up with the browser simulation, or vice-versa.
 */
export function isTauri(): boolean {
  return isTauriRuntime();
}

let bridge: DesktopBridge | null = null;

export function getBridge(): DesktopBridge {
  if (!bridge) {
    if (detectRuntime() === "tauri") {
      // Constructed lazily so the browser/test bundle never imports the
      // Tauri plugin entrypoints.
      const { TauriBridge } = requireTauriBridge();
      bridge = new TauriBridge();
    } else {
      bridge = new BrowserBridge();
    }
  }
  return bridge;
}

/** Test seam: reset the cached bridge between runtime switches. */
export function resetBridgeForTesting(): void {
  bridge = null;
}

/** Test seam for service workflows that must await native result objects. */
export function setBridgeForTesting(next: DesktopBridge | null): void {
  bridge = next;
}

// Synchronous require shim: getBridge() is called from sync UI code, but the
// Tauri branch only runs inside the Tauri runtime where the module graph is
// already loaded. We resolve it through the pre-registered module.
function requireTauriBridge(): { TauriBridge: new () => DesktopBridge } {
  return tauriBridgeModule!;
}

let tauriBridgeModule: { TauriBridge: new () => DesktopBridge } | null = null;

/** Called once during desktop boot (main.tsx) to register the native bridge. */
export async function preloadTauriBridge(): Promise<void> {
  if (detectRuntime() !== "tauri") return;
  const mod = await import("./tauriBridge");
  tauriBridgeModule = { TauriBridge: mod.TauriBridge };
}

export type { DesktopBridge };
