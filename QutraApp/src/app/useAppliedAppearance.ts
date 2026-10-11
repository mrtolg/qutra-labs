import { useEffect } from "react";
import { usePreferences } from "@/lib/db/database";
import {
  applyAppearanceAttributes,
  probeAppearanceCapabilities,
  resolveAppearance,
} from "@/lib/appearance";
import { draftToPrefs, useAppearanceDraft } from "@/lib/appearanceDraft";
import { applyBrandWindowIcon, brandVariant } from "@/lib/brand";

/**
 * The only writer of the document root's appearance: the stored preferences,
 * with the Appearance draft over them while one is being tried. Re-resolves
 * when either changes and when the OS switches light/dark.
 */
export function useAppliedAppearance(): void {
  const prefs = usePreferences();
  const draft = useAppearanceDraft((s) => s.draft);

  useEffect(() => {
    const root = document.documentElement;
    const shown = draft ? { ...prefs, ...draftToPrefs(draft) } : prefs;
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      applyAppearanceAttributes(
        root,
        resolveAppearance(shown, probeAppearanceCapabilities(), scheme.matches),
      );
    apply();
    root.dataset.density = prefs.density;
    root.dataset.reduceMotion = String(prefs.reduceMotion);
    root.lang = prefs.locale;
    scheme.addEventListener("change", apply);
    return () => scheme.removeEventListener("change", apply);
  }, [prefs, draft]);

  // The window and taskbar icon follow what is stored, not a preview.
  useEffect(() => {
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const resolved = resolveAppearance(prefs, probeAppearanceCapabilities(), scheme.matches);
    void applyBrandWindowIcon(brandVariant(resolved));
  }, [prefs]);
}
