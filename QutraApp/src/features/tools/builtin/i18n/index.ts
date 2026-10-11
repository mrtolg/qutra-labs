import { useCallback, useEffect, useReducer } from "react";
import { translate, useT as useAppT, type Locale, type MessageKey } from "@/lib/i18n";
import { builtinEn, type BuiltinKey } from "./en";

/* The built-in tools' own catalogs, loaded with their panels (one lazy
   chunk, plus one small chunk per language): their ~350 messages stay out
   of the first-paint bundle, which carries the English app catalog.
   `t` takes a built-in key or any app key, so the panels can use the app's
   shared words (scope decisions, observation labels) as they are. */

export type { BuiltinKey };
export type AnyKey = BuiltinKey | MessageKey;
export type BuiltinTranslate = (key: AnyKey, params?: Record<string, string | number>) => string;

type Catalog = Record<BuiltinKey, string>;

const catalogs: Partial<Record<Locale, Catalog>> = { en: builtinEn };

const loaders = {
  tr: () => import("./tr").then((m) => m.builtinTr),
  de: () => import("./de").then((m) => m.builtinDe),
  es: () => import("./es").then((m) => m.builtinEs),
  fr: () => import("./fr").then((m) => m.builtinFr),
  it: () => import("./it").then((m) => m.builtinIt),
} satisfies Record<Exclude<Locale, "en">, () => Promise<Catalog>>;

const pending = new Map<Locale, Promise<void>>();

export function builtinLocaleReady(locale: Locale): boolean {
  return Boolean(catalogs[locale]);
}

export function ensureBuiltinLocale(locale: Locale): Promise<void> {
  if (catalogs[locale] || locale === "en") return Promise.resolve();
  const existing = pending.get(locale);
  if (existing) return existing;
  const request = loaders[locale]().then((catalog) => {
    catalogs[locale] = catalog;
    pending.delete(locale);
  });
  pending.set(locale, request);
  return request;
}

const isBuiltinKey = (key: string): key is BuiltinKey =>
  Object.prototype.hasOwnProperty.call(builtinEn, key);

export function translateBuiltin(
  locale: Locale,
  key: AnyKey,
  params?: Record<string, string | number>,
): string {
  if (!isBuiltinKey(key)) return translate(locale, key, params);
  let message: string = catalogs[locale]?.[key] ?? builtinEn[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      message = message.replaceAll(`{${name}}`, String(value));
    }
  }
  return message;
}

/** The panels' `t`: the reader's language once its catalog is in. */
export function useT() {
  const { locale } = useAppT();
  const [, loaded] = useReducer((n: number) => n + 1, 0);
  const ready = builtinLocaleReady(locale as Locale);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void ensureBuiltinLocale(locale as Locale)
      .then(() => {
        if (live) loaded();
      })
      .catch(() => {
        // A missing chunk leaves the English words, which always load.
      });
    return () => {
      live = false;
    };
  }, [locale, ready]);
  const t = useCallback<BuiltinTranslate>(
    (key, params) => translateBuiltin(locale as Locale, key, params),
    // `ready` re-creates t once the catalog arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, ready],
  );
  return { t, locale, ready };
}
