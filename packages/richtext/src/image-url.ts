/**
 * rewriteImageSrc — normalize DQX image URLs to our own `/img/<host>/<path>`
 * proxy path (see docs/plan.md §7). The proxy lazily mirrors upstream to R2 on
 * first view; encoding the upstream host in the path keeps the rewrite lossless
 * (the proxy inverts `/img/<host>/<path>` → `https://<host>/<path>`) and
 * collision-free across the several DQX image hosts.
 *
 * Corpus hosts (by frequency): cache.hiroba.dqx.jp (CDN, ~92%), root-relative
 * `/dq_resource/…`, faceicon.dqx.jp (user avatars), hiroba.dqx.jp,
 * close.cache.hiroba.dqx.jp.
 *
 * Rewrites (any `*.dqx.jp` host, plus root-relative `/dq_resource/`):
 *   • https://cache.hiroba.dqx.jp/PATH     → /img/cache.hiroba.dqx.jp/PATH
 *   • https://faceicon.dqx.jp/icon1/x.jpg  → /img/faceicon.dqx.jp/icon1/x.jpg
 *   • //hiroba.dqx.jp/PATH                 → /img/cache.hiroba.dqx.jp/PATH  (aliased)
 *   • /dq_resource/…  (root-relative)      → /img/cache.hiroba.dqx.jp/dq_resource/…
 *
 * `hiroba.dqx.jp` mirrors `cache.hiroba.dqx.jp` byte-for-byte (verified: several
 * `/dq_resource` assets returned identical md5 + size from both), so it — and
 * root-relative paths, which resolve to that origin — canonicalize to
 * `cache.hiroba.dqx.jp` and dedup to one R2 key. `close.cache.hiroba.dqx.jp`
 * (3 URLs across 2 topics) is dead: it 403s everything, even in a real browser —
 * but the same `/dq_resource` paths load correctly on `cache`, so canonicalizing
 * it to `cache` isn't just safe, it's what makes those images render at all.
 * Distinct hosts (e.g. faceicon) stay distinct and never collide; off-site hosts
 * (e.g. ganganonline.com), already-proxied `/img/…`, and `data:` URIs are
 * unchanged.
 */

/** The canonical DQX CDN host that mirrors `/dq_resource` assets. */
const CDN = 'cache.hiroba.dqx.jp';

/** Hosts that serve the same `/dq_resource` assets as {@link CDN}. */
const CDN_ALIASES: ReadonlySet<string> = new Set([
  'cache.hiroba.dqx.jp',
  'close.cache.hiroba.dqx.jp',
  'hiroba.dqx.jp',
]);

const isDqxHost = (host: string): boolean => host === 'dqx.jp' || host.endsWith('.dqx.jp');
const canonicalHost = (host: string): string => (CDN_ALIASES.has(host) ? CDN : host);

export function rewriteImageSrc(src: string): string {
  if (!src) return src;

  // Absolute or protocol-relative URLs.
  if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
    try {
      const url = new URL(src.startsWith('//') ? `https:${src}` : src);
      if (isDqxHost(url.hostname)) {
        return `/img/${canonicalHost(url.hostname)}${url.pathname}${url.search}`;
      }
    } catch {
      // unparseable — leave as-is
    }
    return src;
  }

  // Already proxied.
  if (src.startsWith('/img/')) return src;
  // Root-relative CDN resources resolve against the page origin (hiroba.dqx.jp),
  // which mirrors /dq_resource to the CDN.
  if (src.startsWith('/dq_resource/')) return `/img/${CDN}${src}`;

  return src;
}
