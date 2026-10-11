import { useEffect, useState } from "react";
import { getDb, usePreferences } from "@/lib/db/database";
import type { MessageKey } from "@/lib/i18n/en";

/* One context panel. Its open state, segment and width are
   preferences, so any part of the app can open it on the right segment
   without holding a reference to it. */

export const CONTEXT_SEGMENTS = ["project", "files", "repo", "runs"] as const;
export type ContextSegment = (typeof CONTEXT_SEGMENTS)[number];

export const SEGMENT_LABEL: Record<ContextSegment, MessageKey> = {
  project: "ctx.seg.project",
  files: "ctx.seg.files",
  repo: "ctx.seg.repo",
  runs: "ctx.seg.runs",
};

/** At this window width and below the panel overlays the surface. */
export const OVERLAY_MAX_WIDTH = 1100;

/** True while the window is narrow enough for the overlay form. */
export function useOverlayForm(): boolean {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width <= OVERLAY_MAX_WIDTH;
}

/**
 * True while the open panel overlays the rail and the surface. What it covers
 * turns inert, so keyboard focus never sits on a control hidden behind it.
 */
export function useSurfaceCovered(): boolean {
  const overlay = useOverlayForm();
  const open = usePreferences().contextPanelOpen;
  return overlay && open;
}

export function openContextPanel(segment?: ContextSegment): void {
  getDb().prefs.set(
    segment ? { contextPanelOpen: true, contextPanelSegment: segment } : { contextPanelOpen: true },
  );
}

export function closeContextPanel(): void {
  getDb().prefs.set({ contextPanelOpen: false });
}

export function toggleContextPanel(): void {
  getDb().prefs.set({ contextPanelOpen: !getDb().prefs.get().contextPanelOpen });
}
