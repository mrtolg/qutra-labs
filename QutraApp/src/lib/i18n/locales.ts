/**
 * Single typed source of truth for supported locales (BCP 47).
 * Adding a language = add its module + one row here.
 */
export const SUPPORTED_LOCALES = ["en", "tr", "de", "es", "fr", "it"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Native (endonym) display names, shown in the language picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  tr: "Türkçe",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  it: "Italiano",
};

export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Map an OS/browser language tag to a supported locale (first launch). */
export function resolveLocale(tag: string | undefined): Locale {
  if (!tag) return DEFAULT_LOCALE;
  const primary = tag.toLowerCase().split("-")[0];
  return isLocale(primary) ? primary : DEFAULT_LOCALE;
}
