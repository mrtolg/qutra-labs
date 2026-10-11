import type { Preferences } from "@/domain/types";
import { getDb } from "@/lib/db/database";
import { hideKeyFor, type PageId } from "./guides";

/* The companion's two saved choices: whether it follows the user at all, and
   the pages where it stays out of the way. Both live in preferences, so they
   survive a restart like any other setting. */

/** The most pages that can be hidden (the schema's own ceiling). */
const MAX_HIDDEN = 24;

export function setCompanionEnabled(enabled: boolean): void {
  getDb().prefs.set({ companionEnabled: enabled });
}

/** Whether the bubble is drawn on this page. */
export function companionVisibleOn(
  prefs: Pick<Preferences, "companionEnabled" | "companionHidden">,
  page: PageId,
): boolean {
  // The Qutra page has the full chat; the bubble would only repeat it.
  if (!prefs.companionEnabled || page === "assistant") return false;
  return !prefs.companionHidden.includes(hideKeyFor(page));
}

/** Hide the bubble on a page's area; returns the key stored. */
export function hideCompanionOn(page: PageId): string {
  const key = hideKeyFor(page);
  const current = getDb().prefs.get().companionHidden;
  if (!current.includes(key)) {
    getDb().prefs.set({ companionHidden: [...current, key].slice(-MAX_HIDDEN) });
  }
  return key;
}

/** Show the bubble again on an area, by the key `hideCompanionOn` returned. */
export function showCompanionOn(key: string): void {
  const current = getDb().prefs.get().companionHidden;
  if (current.includes(key)) {
    getDb().prefs.set({ companionHidden: current.filter((item) => item !== key) });
  }
}
