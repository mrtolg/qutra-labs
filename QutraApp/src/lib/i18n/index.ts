import { useCallback, useEffect, useReducer, useSyncExternalStore } from "react";
import { en, type CatalogKey, type MessageKey } from "./en";
import type { DeferredKey } from "./deferred/en";
import {
  DEFAULT_LOCALE,
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
  resolveLocale,
  type Locale,
} from "./locales";
import { getDb, usePreferences } from "@/lib/db/database";

export type { MessageKey };
export type { Locale };
export { SUPPORTED_LOCALES, LOCALE_NAMES, DEFAULT_LOCALE };

type Catalog = Record<CatalogKey, string>;
type Deferred = Record<DeferredKey, string>;

const catalogs: Partial<Record<Locale, Catalog>> = {
  en,
};

const loaders = {
  tr: () => import("./tr").then((module) => module.tr),
  de: () => import("./de").then((module) => module.de),
  es: () => import("./es").then((module) => module.es),
  fr: () => import("./fr").then((module) => module.fr),
  it: () => import("./it").then((module) => module.it),
} satisfies Record<Exclude<Locale, "en">, () => Promise<Catalog>>;

const pending = new Map<Locale, Promise<Catalog>>();

export async function ensureLocaleLoaded(locale: Locale): Promise<void> {
  if (catalogs[locale]) return;
  const existing = pending.get(locale);
  if (existing) {
    await existing;
    return;
  }
  if (locale === "en") return;

  const request = loaders[locale]().then((catalog) => {
    catalogs[locale] = catalog;
    pending.delete(locale);
    return catalog;
  });
  pending.set(locale, request);
  await request;
}

/* ---------- Deferred words (./deferred)

   Words that only lazily loaded pages read (Qutra, Settings and its
   sections) stay out of the first paint. They load right after it, English
   with the user's language, and every lazy page waits for them through
   withDeferredCopy, so such a page never paints a key. A first paint that
   names one (none should: src/lib/i18n/deferred keeps those in the catalog)
   would show English, or the key, until they arrive and then re-render. */

const deferred: Partial<Record<Locale, Deferred>> = {};
const deferredLoaders = {
  en: () => import("./deferred/en").then((module) => module.deferredEn),
  tr: () => import("./deferred/tr").then((module) => module.deferredTr),
  de: () => import("./deferred/de").then((module) => module.deferredDe),
  es: () => import("./deferred/es").then((module) => module.deferredEs),
  fr: () => import("./deferred/fr").then((module) => module.deferredFr),
  it: () => import("./deferred/it").then((module) => module.deferredIt),
} satisfies Record<Locale, () => Promise<Deferred>>;
const deferredPending = new Map<Locale, Promise<void>>();
let deferredVersion = 0;
const deferredListeners = new Set<() => void>();

/** Make one language's deferred words available now (tests, and the loader). */
export function registerDeferredCopy(locale: Locale, copy: Deferred): void {
  deferred[locale] = copy;
  deferredVersion += 1;
  for (const listener of deferredListeners) listener();
}

function loadDeferred(locale: Locale): Promise<void> {
  if (deferred[locale]) return Promise.resolve();
  const existing = deferredPending.get(locale);
  if (existing) return existing;
  const request = deferredLoaders[locale]()
    .then((copy) => registerDeferredCopy(locale, copy))
    .finally(() => deferredPending.delete(locale));
  deferredPending.set(locale, request);
  return request;
}

/** English and `locale`'s deferred words; resolves once both are in. */
export function ensureDeferredCopy(locale: Locale): Promise<void> {
  return Promise.all([loadDeferred("en"), loadDeferred(locale)]).then(() => undefined);
}

/** A lazy page's loader that also waits for the deferred words, so the
    page's first render has them: `lazy(withDeferredCopy(() => import(…)))`.
    A failed load of the words never blocks the page; it falls back to the
    catalog, then to the key. */
export function withDeferredCopy<T>(load: () => Promise<T>): () => Promise<T> {
  return () => {
    const locale = resolveLocale(getDb().prefs.get().locale);
    return Promise.all([load(), ensureDeferredCopy(locale).catch(() => undefined)]).then(
      ([module]) => module,
    );
  };
}

const subscribeDeferred = (listener: () => void) => {
  deferredListeners.add(listener);
  return () => {
    deferredListeners.delete(listener);
  };
};
const deferredSnapshot = () => deferredVersion;

export function translate(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const name = key as string;
  const lookup = (table: Partial<Record<string, string>> | undefined) => table?.[name];
  // The user's language first (catalog, then deferred words), then English,
  // the guaranteed fallback for an unexpected missing key.
  let msg =
    lookup(catalogs[locale]) ??
    lookup(deferred[locale]) ??
    lookup(en) ??
    lookup(deferred.en) ??
    name;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replaceAll(`{${k}}`, String(v));
    }
  }
  return msg;
}

/** Detect an initial locale from the OS/browser on first launch. */
export function detectLocale(): Locale {
  try {
    return resolveLocale(navigator.language);
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function useT() {
  const prefs = usePreferences();
  const locale = prefs.locale as Locale;
  const [, catalogLoaded] = useReducer((value: number) => value + 1, 0);
  const localeReady = Boolean(catalogs[locale]);
  const resolvedLocale = localeReady ? locale : DEFAULT_LOCALE;
  // A component re-renders when the deferred words arrive.
  const deferredReady = useSyncExternalStore(subscribeDeferred, deferredSnapshot, deferredSnapshot);

  useEffect(() => {
    if (localeReady) return;
    let active = true;
    void ensureLocaleLoaded(locale)
      .then(() => {
        if (active) catalogLoaded();
      })
      .catch(() => {
        // A missing locale chunk degrades to the guaranteed English catalog.
      });
    return () => {
      active = false;
    };
  }, [locale, localeReady]);

  // Right after the first paint, fetch the words lazy pages read.
  useEffect(() => {
    void ensureDeferredCopy(resolveLocale(locale)).catch(() => {
      // Lazy pages ask again through withDeferredCopy.
    });
  }, [locale]);

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>) =>
      translate(resolvedLocale, key, params),
    // deferredReady: a new `t` once the deferred words are in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedLocale, deferredReady],
  );
  return { t, locale };
}
