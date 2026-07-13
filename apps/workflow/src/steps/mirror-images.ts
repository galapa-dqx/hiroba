/**
 * Mirror-images step — pull every image a topic references into our R2 bucket,
 * so the site serves self-hosted copies instead of proxying the DQX CDN on each
 * view (cheaper, and resilient to the source going away or blocking our UA).
 *
 * Keyed by @hiroba/richtext's `imageKey` (`<host>/<path>`, alias-canonicalized),
 * which is the same key the web `/img` route and any bucket custom-domain read.
 * Idempotent: skips keys already in the bucket, so re-runs are cheap and the
 * transcribe step can read the bytes back from R2 (one CDN fetch per image ever).
 */

import {
  ensureImageRows,
  setImageMirrorState,
  type Database,
} from '@hiroba/db';
import {
  collectImageUrls,
  imageKey,
  imageUpstreamUrl,
  type Block,
} from '@hiroba/richtext';

import { mapWithConcurrency } from '../concurrency';

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
 * Mirror a single image key into R2 (the per-unit worker behind
 * `mirrorImages`, exported for the flow framework's per-image `map` units).
 * Assumes the key's `images` row exists (ensureImageRows ran). Never throws
 * for an upstream failure — the row is marked failed and the outcome says so,
 * because one bad image degrades the article, never blocks it.
 */
export async function mirrorOneImage(
  db: Database,
  bucket: R2Bucket,
  key: string,
): Promise<MirrorOutcome> {
  if (await bucket.head(key)) {
    await setImageMirrorState(db, key, 'done');
    return 'skipped';
  }
  await setImageMirrorState(db, key, 'running');
  try {
    const res = await fetch(imageUpstreamUrl(key), {
      headers: FETCH_HEADERS,
    });
    if (!res.ok || !res.body) {
      await setImageMirrorState(db, key, 'failed');
      return 'failed';
    }
    await bucket.put(key, res.body, {
      httpMetadata: {
        contentType:
          res.headers.get('content-type') ?? 'application/octet-stream',
        cacheControl: CACHE_CONTROL,
      },
    });
    await setImageMirrorState(db, key, 'done');
    return 'mirrored';
  } catch {
    await setImageMirrorState(db, key, 'failed');
    return 'failed';
  }
}

/**
 * Mirror all mirrorable images in `blocks` to `bucket`. Fetches each missing key
 * from the DQX CDN once and streams it into R2 with a content type + long TTL.
 *
 * Also the pipeline's image-discovery point: every referenced key gets an
 * `images` row here (pending), and its mirror_state tracks the copy — that's
 * what feeds the "Downloading images (x/y)" progress in the SSE snapshot.
 */
export async function mirrorImages(
  db: Database,
  bucket: R2Bucket,
  blocks: Block[],
): Promise<MirrorResult> {
  // Dedup to distinct storage keys (many srcs collapse to one key via aliasing).
  const keys = new Set<string>();
  for (const src of collectImageUrls(blocks)) {
    const key = imageKey(src);
    if (key) keys.add(key);
  }

  await ensureImageRows(db, [...keys]);

  const result: MirrorResult = { mirrored: 0, skipped: 0, failed: 0 };
  await mapWithConcurrency([...keys], MIRROR_CONCURRENCY, async (key) => {
    const outcome = await mirrorOneImage(db, bucket, key);
    result[outcome]++;
  });
  return result;
}
