import { useCallback, useEffect, useReducer } from "react";
import { usePreferences } from "@/lib/db/database";
import { resolveLocale, type Locale } from "../locales";
import { toolFormsEn, type ToolFormsKey } from "./en";

/* The tool forms' words, apart from the main catalogs. Only the Tools page
   imports this module, so English arrives with that page's chunk and the
   other languages load when the page first asks for them. Keys are built
   from the data file's ids, so a lookup takes any string and falls back to
   English, then to the key itself. */

export type { ToolFormsKey };
type Copy = Record<ToolFormsKey, string>;

const copies: Partial<Record<Locale, Copy>> = { en: toolFormsEn };

const loaders = {
  tr: () => import("./tr").then((module) => module.toolFormsTr),
  de: () => import("./de").then((module) => module.toolFormsDe),
  es: () => import("./es").then((module) => module.toolFormsEs),
  fr: () => import("./fr").then((module) => module.toolFormsFr),
  it: () => import("./it").then((module) => module.toolFormsIt),
} satisfies Record<Exclude<Locale, "en">, () => Promise<Copy>>;

export async function ensureToolFormsLoaded(locale: Locale): Promise<void> {
  if (copies[locale] || locale === "en") return;
  copies[locale] = await loaders[locale]();
}

export function translateToolForms(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const lookup = (copy: Copy | undefined) => (copy as Record<string, string> | undefined)?.[key];
  let message = lookup(copies[locale]) ?? lookup(copies.en) ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      message = message.replaceAll(`{${name}}`, String(value));
    }
  }
  return message;
}

/** The forms' words in the user's language; English until it has loaded. */
export function useToolFormsT() {
  const locale = resolveLocale(usePreferences().locale);
  const [, loaded] = useReducer((value: number) => value + 1, 0);
  const ready = Boolean(copies[locale]);

  useEffect(() => {
    if (ready) return;
    let active = true;
    void ensureToolFormsLoaded(locale)
      .then(() => {
        if (active) loaded();
      })
      .catch(() => {
        // A missing chunk leaves the English words in place.
      });
    return () => {
      active = false;
    };
  }, [locale, ready]);

  return useCallback(
    (key: string, params?: Record<string, string | number>) =>
      translateToolForms(ready ? locale : "en", key, params),
    [locale, ready],
  );
}
