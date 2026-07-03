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

import { collectImageUrls, imageKey, imageUpstreamUrl, type Block } from '@hiroba/richtext';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://hiroba.dqx.jp/',
};

/** Long-lived cache — mirrored assets are immutable under their content key. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export type MirrorResult = {
  /** newly written to R2 this run */
  mirrored: number;
  /** already present, skipped */
  skipped: number;
  /** upstream fetch failed */
  failed: number;
};

/**
 * Mirror all mirrorable images in `blocks` to `bucket`. Fetches each missing key
 * from the DQX CDN once and streams it into R2 with a content type + long TTL.
 */
export async function mirrorImages(bucket: R2Bucket, blocks: Block[]): Promise<MirrorResult> {
  // Dedup to distinct storage keys (many srcs collapse to one key via aliasing).
  const keys = new Set<string>();
  for (const src of collectImageUrls(blocks)) {
    const key = imageKey(src);
    if (key) keys.add(key);
  }

  let mirrored = 0;
  let skipped = 0;
  let failed = 0;

  for (const key of keys) {
    if (await bucket.head(key)) {
      skipped++;
      continue;
    }
    try {
      const res = await fetch(imageUpstreamUrl(key), { headers: FETCH_HEADERS });
      if (!res.ok || !res.body) {
        failed++;
        continue;
      }
      await bucket.put(key, res.body, {
        httpMetadata: {
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
          cacheControl: CACHE_CONTROL,
        },
      });
      mirrored++;
    } catch {
      failed++;
    }
  }

  return { mirrored, skipped, failed };
}
