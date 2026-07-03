/**
 * Image serving — `/img/<host>/<path>` → the R2 mirror, self-healing on miss.
 *
 * `rewriteImageSrc` encodes the upstream host as the first path segment; that
 * `<host>/<path>` is exactly the R2 object key the pipeline's mirror-images step
 * writes. We serve from R2 first; on a miss (a topic viewed before its pipeline
 * ran, or an off-pipeline image) we fetch the DQX CDN once, store it, and serve
 * it — so the second view is a pure R2 read. Host is allowlisted to `*.dqx.jp`.
 *
 * A bucket custom-domain can later serve these keys directly (set the image base
 * so `rewriteImageSrc` points at it) — no worker hop — without changing storage.
 */

import type { APIRoute } from 'astro';

const isAllowedHost = (host: string): boolean => host === 'dqx.jp' || host.endsWith('.dqx.jp');

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://hiroba.dqx.jp/',
};

/** Served to the browser — a week is plenty; the object is immutable in R2. */
const CACHE_CONTROL = 'public, max-age=604800, immutable';

export const GET: APIRoute = async ({ params, locals }) => {
  const path = params.path ?? '';
  const slash = path.indexOf('/');
  const host = slash === -1 ? path : path.slice(0, slash);
  const rest = slash === -1 ? '' : path.slice(slash + 1);

  if (!host || !rest || !isAllowedHost(host)) {
    return new Response('Forbidden', { status: 403 });
  }

  const bucket = locals.runtime.env.IMAGES;
  const key = `${host}/${rest}`;

  // 1. Serve from the R2 mirror when present.
  const hit = await bucket.get(key);
  if (hit) {
    return new Response(hit.body, {
      headers: {
        'Content-Type': hit.httpMetadata?.contentType ?? 'application/octet-stream',
        'Cache-Control': CACHE_CONTROL,
        ETag: hit.httpEtag,
      },
    });
  }

  // 2. Miss → fetch the CDN once, store, and serve.
  const res = await fetch(`https://${key}`, { headers: FETCH_HEADERS });
  if (!res.ok) {
    return new Response('Upstream error', { status: res.status });
  }
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const body = await res.arrayBuffer();

  await bucket.put(key, body, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
  });

  return new Response(body, {
    headers: { 'Content-Type': contentType, 'Cache-Control': CACHE_CONTROL },
  });
};
