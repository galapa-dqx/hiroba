/**
 * Primary translation target language — the language the admin is currently
 * "viewing" (e.g. which localized image the Images screen shows). Persisted in
 * localStorage and broadcast so the sidebar selector and any island reading it
 * (the Images screen) stay in sync without a page reload.
 *
 * Kept framework-agnostic: the selector lives in the Astro layout, the readers
 * are React islands, so this is plain DOM + a CustomEvent.
 */

const PRIMARY_LANG_KEY = 'dqx-admin-primary-lang';
const PRIMARY_LANG_EVENT = 'dqx-admin-primary-lang-change';
const DEFAULT_PRIMARY_LANG = 'en';

/** The stored primary language, or the English default when unset/unavailable. */
export function getPrimaryLanguage(): string {
  try {
    return localStorage.getItem(PRIMARY_LANG_KEY) || DEFAULT_PRIMARY_LANG;
  } catch {
    return DEFAULT_PRIMARY_LANG;
  }
}

/**
 * Persist the primary language and notify listeners in this tab. Storage events
 * cover other tabs; the CustomEvent covers this one (storage doesn't fire on the
 * writing tab).
 */
export function setPrimaryLanguage(code: string): void {
  try {
    localStorage.setItem(PRIMARY_LANG_KEY, code);
  } catch {
    /* storage unavailable — the change still applies for this page view */
  }
  window.dispatchEvent(new CustomEvent(PRIMARY_LANG_EVENT, { detail: code }));
}

/** Subscribe to primary-language changes (same tab + cross-tab). Returns an unsubscribe. */
export function subscribePrimaryLanguage(
  cb: (code: string) => void,
): () => void {
  const onCustom = (e: Event) => cb((e as CustomEvent<string>).detail);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PRIMARY_LANG_KEY && e.newValue) cb(e.newValue);
  };
  window.addEventListener(PRIMARY_LANG_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PRIMARY_LANG_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
