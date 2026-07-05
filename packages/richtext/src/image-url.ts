/**
 * Image URL handling for DQX topics. A single {@link imageKey} maps any upstream
 * DQX image URL to a stable, collision-free storage key `<host>/<path>` used
 * both as the R2 object key (the pipeline mirrors images there — see the
 * workflow's mirror-images step) and as the tail of our `/img/<host>/<path>`
 * serving path. {@link rewriteImageSrc} turns a src into a servable URL under a
 * configurable base (default `/img`, the web worker's R2-backed route; set it to
 * a bucket custom-domain to serve straight from R2 with no worker hop).
 *
 * Corpus hosts (by frequency): cache.hiroba.dqx.jp (CDN, ~92%), root-relative
 * `/dq_resource/…`, faceicon.dqx.jp (user avatars), hiroba.dqx.jp,
 * close.cache.hiroba.dqx.jp.
 *
 * `hiroba.dqx.jp` mirrors `cache.hiroba.dqx.jp` byte-for-byte (verified: several
 * `/dq_resource` assets returned identical md5 + size from both), so it — and
 * root-relative paths, which resolve to that origin — canonicalize to
 * `cache.hiroba.dqx.jp` and dedup to one key. `close.cache.hiroba.dqx.jp`
 * (3 URLs across 2 topics) is dead: it 403s everything, even in a real browser —
 * but the same `/dq_resource` paths load correctly on `cache`, so canonicalizing
 * it to `cache` isn't just safe, it's what makes those images render at all.
 * Distinct hosts (e.g. faceicon) stay distinct and never collide; off-site hosts
 * (e.g. ganganonline.com), already-served `/img/…`, and `data:` URIs are not keyed.
 *
 * The key intentionally drops any query string (DQX image URLs are static assets;
 * a `?` in the key would break custom-domain direct-serve, where it reads as a
 * query rather than part of the object key).
 */

import type { Block, ImageNode } from './schema';
import { walk } from './traverse';

/** The canonical DQX CDN host that mirrors `/dq_resource` assets. */
const CDN = 'cache.hiroba.dqx.jp';

/** Hosts that serve the same `/dq_resource` assets as {@link CDN}. */
const CDN_ALIASES: ReadonlySet<string> = new Set([
  'cache.hiroba.dqx.jp',
  'close.cache.hiroba.dqx.jp',
  'hiroba.dqx.jp',
]);

const isDqxHost = (host: string): boolean =>
  host === 'dqx.jp' || host.endsWith('.dqx.jp');
const canonicalHost = (host: string): string =>
  CDN_ALIASES.has(host) ? CDN : host;

/**
 * The stable storage key for a DQX image URL: `<canonical-host>/<path>` with no
 * query string. Returns null for anything we don't mirror (off-site hosts,
 * already-served `/img/…`, `data:` URIs, other relative paths).
 */
export function imageKey(src: string): string | null {
  if (!src) return null;

  // Absolute or protocol-relative URLs.
  if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
    try {
      const url = new URL(src.startsWith('//') ? `https:${src}` : src);
      if (isDqxHost(url.hostname))
        return `${canonicalHost(url.hostname)}${url.pathname}`;
    } catch {
      // unparseable — not keyable
    }
    return null;
  }

  // Already served by us — no upstream to key.
  if (src.startsWith('/img/')) return null;
  // Root-relative CDN resources resolve against the page origin (hiroba.dqx.jp),
  // which mirrors /dq_resource to the CDN.
  if (src.startsWith('/dq_resource/')) return `${CDN}${src.split('?')[0]}`;

  return null;
}

/**
 * The upstream https URL an {@link imageKey} was derived from (for fetching /
 * mirroring). Inverse of the key: `<host>/<path>` → `https://<host>/<path>`.
 */
export function imageUpstreamUrl(key: string): string {
  return `https://${key}`;
}

/**
 * Rewrite an image `src` to a servable URL. Mirrorable DQX images become
 * `<base>/<key>` (default base `/img`); everything else is returned unchanged.
 */
export function rewriteImageSrc(src: string, base = '/img'): string {
  if (!src) return src;
  if (src.startsWith('/img/')) return src; // already served by us (idempotent)
  const key = imageKey(src);
  return key ? `${base}/${key}` : src;
}

/**
 * Every block-level image node in the tree, in document order (returns the live
 * references so callers can hydrate `text`). Two trees of the same document (JA
 * and its translation) yield images in matching order, so callers pair by index.
 */
export function collectImages(blocks: Block[]): ImageNode[] {
  const out: ImageNode[] = [];
  walk(blocks, (n) => {
    if (typeof n !== 'string' && n.type === 'image') out.push(n);
  });
  return out;
}

/**
 * Every mirrorable image URL referenced anywhere in a block tree — block images
 * (+ responsive sources), inline icons, and speech-bubble portraits. Deduped.
 * Used by the mirror-images step to pull each asset into R2 exactly once.
 */
export function collectImageUrls(blocks: Block[]): string[] {
  const urls = new Set<string>();
  // The walk reaches every node; this switch only picks out the ones whose
  // *attributes* carry an image URL, so unlisted types are simply URL-free.
  walk(blocks, (n) => {
    if (typeof n === 'string') return;
    switch (n.type) {
      case 'image':
        if (n.src) urls.add(n.src);
        n.sources?.forEach((s) => s.src && urls.add(s.src));
        break;
      case 'icon':
        if (n.src) urls.add(n.src);
        break;
      case 'speechBubble':
        if (n.icon) urls.add(n.icon);
        break;
      default:
        break;
    }
  });
  return [...urls];
}
