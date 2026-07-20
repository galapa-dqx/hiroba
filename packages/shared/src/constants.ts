/**
 * Shared constants for the Hiroba news translation system.
 */

// News categories
export const CATEGORIES = ['news', 'event', 'update', 'maintenance'] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Maps Japanese category names to English slugs.
 * Used when parsing scraped content.
 */
export const CATEGORY_MAP: Record<string, Category> = {
  ニュース: 'news',
  イベント: 'event',
  アップデート: 'update',
  メンテナンス: 'maintenance',
  障害: 'maintenance',
};

/**
 * Human-readable labels for categories.
 * Used in UI display.
 */
export const CATEGORY_LABELS: Record<Category, string> = {
  news: 'News',
  event: 'Events',
  update: 'Updates',
  maintenance: 'Maintenance',
};

/**
 * Localized image rasters are written to VERSIONED R2 keys —
 * `l10n/<lang>/v<version>/<host>/<path>` (see localizedImageKey) — a fresh key
 * per render, never overwritten in place. That makes them safely `immutable`
 * like the content-keyed originals: a regenerate or upload mints a new URL,
 * the translation row records it, pages embedding the image are purged, and
 * every cache (edge and browser, however old) is bypassed instantly. Old
 * versions linger as orphans so long-cached HTML keeps resolving; they're
 * prunable once nothing can reference them.
 *
 * Legacy objects at unversioned keys (`l10n/<lang>/<host>/<path>`) predate
 * this scheme and were mutated in place — they stay on their original short
 * TTLs until their image is next regenerated, which strands them as orphans.
 */
export const LOCALIZED_IMAGE_CACHE_CONTROL =
  'public, max-age=31536000, immutable';

/** Canonical URL extension per raster content type we store. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

/**
 * Rewrite a storage key so its extension is the canonical one for the bytes
 * actually stored under it (`.jpeg` → `.jpg` included). Localized renders are
 * always re-rasterized (PNG today), while the key tail inherits the SOURCE's
 * path — so a render of `foo.jpg` would otherwise sit at a `.jpg` URL with
 * PNG bytes. Only used when minting keys in our own namespaces (versioned
 * `l10n/` keys are unique per render, so a swap can't collide); mirrored
 * originals keep their upstream path verbatim, since that path IS their
 * identity.
 *
 * Every key we mint is for bytes we produced or validated (gpt-image-2 output,
 * an admin upload restricted to known raster types), so the content type is
 * always one we know — an unknown type is a programmer error, not a case to
 * serve, and throws rather than minting a lying URL.
 */
export function keyWithExtension(key: string, contentType: string): string {
  const ext = EXTENSION_BY_TYPE[contentType];
  if (!ext) throw new Error(`no canonical extension for '${contentType}'`);
  const slash = key.lastIndexOf('/');
  const dot = key.lastIndexOf('.');
  if (dot <= slash + 1) return `${key}${ext}`; // no (or dot-file) extension
  if (key.slice(dot).toLowerCase() === ext) return key;
  return `${key.slice(0, dot)}${ext}`;
}

/**
 * The versioned R2 key for one localized render of a mirrored image.
 * `version` must be unique per render (epoch-ms in base36 is the convention);
 * `imageKey` is the original's `<host>/<path>` storage key. The render's
 * `contentType` corrects the inherited extension to match the stored bytes
 * (see keyWithExtension) — every minted l10n key has a truthful extension.
 * (Readers never derive these keys — they read the recorded `image_files`
 * rows — so the scheme is free to change; the source-path tail is kept for
 * human ops and debuggability.)
 */
export const localizedImageKey = (
  language: string,
  version: string,
  imageKey: string,
  contentType: string,
): string =>
  `l10n/${language}/v${version}/${keyWithExtension(imageKey, contentType)}`;

/**
 * Scraping configuration - source URLs and paths.
 */
export const SCRAPE_CONFIG = {
  baseUrl: 'https://hiroba.dqx.jp',
  newsListPath: '/sc/news/',
  newsDetailPath: '/sc/news/detail/',
  topicsDetailPath: '/sc/topics/detail/',
  // Playguide pages are static reference guides under a single path prefix,
  // identified by a slug (guide01, guide_4_2, wintrial_1, …) rather than a
  // 32-char hex id. The set is discovered by crawling from `guide01`.
  playguideBasePath: '/sc/public/playguide/',
  // つよさ予報 — the recurring battle-content rotation schedules (defense force,
  // panigarm, boot camp, abyss sinners, metal rookie).
  tsuyosaPath: '/sc/tokoyami/',
} as const;
