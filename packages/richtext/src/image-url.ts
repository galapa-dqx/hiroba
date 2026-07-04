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

import { isBlock, type Block, type ContentNode, type ImageNode, type Inline } from './schema';

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
      if (isDqxHost(url.hostname)) return `${canonicalHost(url.hostname)}${url.pathname}`;
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

  const visitContent = (n: ContentNode) => {
    if (isBlock(n)) visitBlock(n);
  };

  const visitBlock = (node: Block) => {
    switch (node.type) {
      case 'image':
        out.push(node);
        break;
      case 'infoBox':
      case 'section':
      case 'accordion':
      case 'speechBubble':
      case 'messageBox':
        node.children.forEach(visitContent);
        break;
      case 'list':
        node.items.forEach((it) => it.children.forEach(visitContent));
        break;
      case 'table':
        node.headers?.forEach((c) => c.children.forEach(visitContent));
        node.rows.forEach((row) => row.forEach((c) => c.children.forEach(visitContent)));
        break;
      case 'interview':
        node.exchanges.forEach((e) => e.answer.forEach(visitBlock));
        break;
      case 'steps':
        node.items.forEach((s) => s.children.forEach(visitBlock));
        break;
      default:
        break; // paragraph/heading/button/divider/video/embed/ranking hold no block images
    }
  };

  blocks.forEach(visitBlock);
  return out;
}

/**
 * Every mirrorable image URL referenced anywhere in a block tree — block images
 * (+ responsive sources), inline icons, and speech-bubble portraits. Deduped.
 * Used by the mirror-images step to pull each asset into R2 exactly once.
 */
export function collectImageUrls(blocks: Block[]): string[] {
  const urls = new Set<string>();

  const addImage = (img: ImageNode) => {
    if (img.src) urls.add(img.src);
    img.sources?.forEach((s) => s.src && urls.add(s.src));
  };

  const visitInline = (n: Inline) => {
    if (typeof n === 'string') return;
    switch (n.type) {
      case 'icon':
        if (n.src) urls.add(n.src);
        break;
      case 'strong':
      case 'emphasis':
      case 'color':
      case 'link':
        n.children.forEach(visitInline);
        break;
      default:
        break; // break, badge, text carry no image
    }
  };

  const visitContent = (n: ContentNode) => (isBlock(n) ? visitBlock(n) : visitInline(n));

  const visitBlock = (node: Block) => {
    switch (node.type) {
      case 'image':
        addImage(node);
        break;
      case 'paragraph':
      case 'heading':
      case 'button':
        node.children.forEach(visitInline);
        break;
      case 'speechBubble':
        if (node.icon) urls.add(node.icon);
        node.children.forEach(visitContent);
        break;
      case 'section':
        node.title?.forEach(visitInline);
        node.dateline?.forEach(visitInline);
        node.children.forEach(visitContent);
        break;
      case 'accordion':
        node.summary.forEach(visitInline);
        node.children.forEach(visitContent);
        break;
      case 'infoBox':
      case 'messageBox':
        node.children.forEach(visitContent);
        break;
      case 'list':
        node.items.forEach((it) => it.children.forEach(visitContent));
        break;
      case 'table':
        node.headers?.forEach((c) => c.children.forEach(visitContent));
        node.rows.forEach((row) => row.forEach((c) => c.children.forEach(visitContent)));
        break;
      case 'interview':
        node.exchanges.forEach((e) => {
          e.question.forEach(visitInline);
          e.answer.forEach(visitBlock);
        });
        break;
      case 'steps':
        node.items.forEach((s) => s.children.forEach(visitBlock));
        break;
      case 'ranking':
        node.items.forEach((it) => it.title.forEach(visitInline));
        break;
      default:
        break; // divider, video, embed carry no image
    }
  };

  blocks.forEach(visitBlock);
  return [...urls];
}
