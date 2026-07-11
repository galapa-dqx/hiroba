/**
 * UI-string localization for the web app's chrome.
 *
 * A tiny static-catalog i18n: `en` (./en.ts) is the base, and languages are
 * registered in `catalogs` below. Lookups fall back per-key to English, so a
 * partially-translated language still renders — and an enabled language with no
 * catalog at all simply shows English. This runs at render time only (Astro
 * frontmatter); no DB, so it also works on the middleware fallback path.
 *
 * To add a language, create `./<code>.ts` exporting a `Partial<Catalog>` and
 * register it here. `<code>` is the same value as the `languages.code` used in
 * the URL prefix.
 */
import {
  DEFAULT_STATUS_STRINGS,
  type Category,
  type StatusStrings,
} from '@hiroba/shared';

import { en } from './en';

export type MessageKey = keyof typeof en;
type Catalog = Partial<Record<MessageKey, string>>;
type Params = Record<string, string | number>;

/** Registered catalogs by language code. English is the base + fallback. */
const catalogs: Record<string, Catalog> = {
  en,
};

const lookup = (lang: string, key: MessageKey): string =>
  catalogs[lang]?.[key] ?? en[key] ?? key;

const interpolate = (template: string, params?: Params): string =>
  params
    ? template.replace(/\{(\w+)\}/g, (m, k: string) =>
        k in params ? String(params[k]) : m,
      )
    : template;

export type Translate = (key: MessageKey, params?: Params) => string;

/** A translator bound to one language, with per-key English fallback. */
export function useTranslations(lang: string): Translate {
  return (key, params) => interpolate(lookup(lang, key), params);
}

/** One-off lookup when building a translator isn't worth it. */
export function t(lang: string, key: MessageKey, params?: Params): string {
  return interpolate(lookup(lang, key), params);
}

/** Localized display label for a news category. */
export function categoryLabel(lang: string, category: Category): string {
  return t(lang, `category.${category}` as MessageKey);
}

/**
 * BCP-47 locale for `Intl` date/number formatting. The `languages.code` is
 * already BCP-47-shaped, so it doubles as the locale; falls back to English.
 */
export function dateLocale(lang: string): string {
  return lang || 'en';
}

/**
 * Localized pipeline-status templates for {@link describeSnapshot}. The count
 * tokens ({count}/{total}/{failed}) are left intact for the formatter to fill.
 */
export function statusStrings(lang: string): StatusStrings {
  const tr = useTranslations(lang);
  return {
    fetchFailed: tr('status.fetchFailed'),
    fetching: tr('status.fetching'),
    downloadingImages: tr('status.downloadingImages'),
    readingImageText: tr('status.readingImageText'),
    translationFailed: tr('status.translationFailed'),
    translating: tr('status.translating'),
    translatingImages: tr('status.translatingImages'),
    imagesFailedOne: tr('status.imagesFailedOne'),
    imagesFailedOther: tr('status.imagesFailedOther'),
    finishing: tr('status.finishing'),
  };
}

// Re-exported so callers building the default set don't need @hiroba/shared.
export { DEFAULT_STATUS_STRINGS };
