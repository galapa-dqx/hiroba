/**
 * Mirror-images step — pull every image a topic references into our R2 bucket,
 * so the site serves self-hosted copies instead of proxying the DQX CDN on each
 * view (cheaper, and resilient to the source going away or blocking our UA).
 *
 * Keyed by @hiroba/richtext's `imageKey` (`<host>/<path>`, alias-canonicalized),
 * which is the same key the web `/img` route and any bucket custom-domain read.
 * Idempotent: skips keys already mirrored, so re-runs are cheap and the
 * transcribe step can read the bytes back from R2 (one CDN fetch per image ever).
 *
 * Mirroring records the original as a render (its `images` row + `image_files`:
 * the primary at the source key with dims measured via the Images binding, plus
 * the derived AVIF encoded beside it) — the reader serves from that render, and
 * its existence IS the "mirrored" signal (DQX-46 dropped `mirror_state`; a
 * failure is no render row plus the flow run's error). That render is therefore
 * also the skip predicate: one indexed D1 read, no R2 round-trip, and exactly
 * one original per source.
 */

import {
  ensureImageSourceRows,
  getImageSourcesByKeys,
  hasOriginalRender,
  insertImageRender,
  type Database,
} from '@hiroba/db';
import {
  collectImageUrls,
  imageKey,
  imageUpstreamUrl,
  type Block,
} from '@hiroba/richtext';

import { mapWithConcurrency } from '../concurrency';
import { sniffMimeType } from '../image-edit';
import { buildRenderFiles } from '../image-files';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://hiroba.dqx.jp/',
};

/** Long-lived cache — mirrored assets are immutable under their content key. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Max concurrent CDN→R2 copies. Network-bound, so a higher cap than the LLM steps. */
const MIRROR_CONCURRENCY = 8;

export type MirrorResult = {
  /** newly written to R2 this run */
  mirrored: number;
  /** already present, skipped */
  skipped: number;
  /** upstream fetch failed */
  failed: number;
};

/** One image's fate through `mirrorOneImage` — the unit of MirrorResult. */
export type MirrorOutcome = 'mirrored' | 'skipped' | 'failed';

/**
 * Record the mirrored original as a render — its `images` row (language NULL)
 * plus its `image_files`: the primary at the source key (dims measured) and
 * whatever derived files encode beside it (DQX-49), all in one atomic insert.
 * Once per source: callers reach here only past a `hasOriginalRender` miss,
 * since the file key is the fixed source key and latest-wins never needs a
 * second original.
 */
async function recordOriginalRender(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  key: string,
  sourceId: number,
  bytes: Uint8Array,
  contentType: string | null,
): Promise<void> {
  const files = await buildRenderFiles(
    images,
    bucket,
    key,
    bytes,
    CACHE_CONTROL,
    { fallbackMime: contentType },
  );
  await insertImageRender(db, {
    id: crypto.randomUUID(),
    sourceId,
    language: null,
    model: null,
    files,
  });
}

/**
 * Log why a key didn't mirror, and return the outcome. Dropping `mirror_state`
 * took away the failed row that used to be the only breadcrumb, so every
 * non-throwing failure says so in the run's logs instead. A thrown value goes
 * in `detail` rather than the message, so an Error keeps its stack.
 */
function failed(key: string, reason: string, detail?: unknown): MirrorOutcome {
  const message = `Failed to mirror ${key}: ${reason}`;
  if (detail === undefined) console.error(message);
  else console.error(message, detail);
  return 'failed';
}

/**
 * Mirror a single image key into R2 (the per-unit worker behind
 * `mirrorImages`, exported for the flow framework's per-image `map` units).
 * Assumes the key's image_sources row exists (ensureImageSourceRows ran).
 *
 * Three paths, cheapest first:
 *  1. the original render exists → already mirrored, nothing to do;
 *  2. no render but the bytes are in the bucket → read them back and record the
 *     render (self-heal: the web/admin `/img` routes restore objects on a miss
 *     without touching D1, so R2 can be ahead of the render table);
 *  3. neither → fetch upstream, store, record.
 *
 * Never throws: one bad image degrades the article, never blocks it. EVERY
 * path is inside the guard, not just the upstream fetch — a D1 read, a
 * corrupted object in the bucket, or a render insert that fails all come back
 * as `'failed'` with no render row, which is exactly the state that makes the
 * next pass retry.
 */
export async function mirrorOneImage(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  key: string,
): Promise<MirrorOutcome> {
  try {
    const [source] = await getImageSourcesByKeys(db, [key]);
    if (source && (await hasOriginalRender(db, source.id))) return 'skipped';

    const stored = await bucket.get(key);
    if (stored) {
      const bytes = new Uint8Array(await stored.arrayBuffer());
      if (source)
        await recordOriginalRender(
          db,
          bucket,
          images,
          key,
          source.id,
          bytes,
          stored.httpMetadata?.contentType ?? null,
        );
      return 'skipped';
    }

    const res = await fetch(imageUpstreamUrl(key), {
      headers: FETCH_HEADERS,
    });
    if (!res.ok || !res.body) return failed(key, `upstream HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A mirrored object must be an image: trust the magic bytes first, the
    // upstream header only when it at least claims image/* (SVG has no
    // sniffable signature). Anything else — an HTML error page served with a
    // 200, a redirect stub — must not be stored under an image key at all.
    const header = res.headers.get('content-type');
    const contentType =
      sniffMimeType(bytes) ?? (header?.startsWith('image/') ? header : null);
    if (!contentType)
      return failed(key, `not an image (content-type ${header ?? 'absent'})`);
    await bucket.put(key, bytes, {
      httpMetadata: { contentType, cacheControl: CACHE_CONTROL },
    });
    if (source)
      await recordOriginalRender(
        db,
        bucket,
        images,
        key,
        source.id,
        bytes,
        contentType,
      );
    return 'mirrored';
  } catch (err) {
    return failed(key, 'unexpected error', err);
  }
}

/**
 * Mirror all mirrorable images in `blocks` to `bucket`. Fetches each missing key
 * from the DQX CDN once and streams it into R2 with a content type + long TTL.
 *
 * Also the pipeline's image-discovery point: every referenced key gets an
 * image_sources row here, so the set is known before any copy completes.
 */
export async function mirrorImages(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  blocks: Block[],
): Promise<MirrorResult> {
  // Dedup to distinct storage keys (many srcs collapse to one key via aliasing).
  const keys = new Set<string>();
  for (const src of collectImageUrls(blocks)) {
    const key = imageKey(src);
    if (key) keys.add(key);
  }

  await ensureImageSourceRows(db, [...keys]);

  const result: MirrorResult = { mirrored: 0, skipped: 0, failed: 0 };
  await mapWithConcurrency([...keys], MIRROR_CONCURRENCY, async (key) => {
    const outcome = await mirrorOneImage(db, bucket, images, key);
    result[outcome]++;
  });
  return result;
}
