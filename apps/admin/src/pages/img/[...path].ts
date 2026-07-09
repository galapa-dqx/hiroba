/**
 * Image serving for the admin panel — R2-backed, self-healing. Same contract as
 * the web worker's `/img` route so the Images screen can reference stored images
 * without reaching across origins:
 *
 *   /img/<host>/<path>             → the mirrored original (R2 key `<host>/<path>`)
 *   /img/l10n/<lang>/<host>/<path> → the localized image (R2 key `l10n/<lang>/…`),
 *                                    falling back to the original when a given
 *                                    image was never localized.
 *
 * On a total miss we fetch the DQX CDN once, store the original, and serve it.
 * Host is allowlisted to `*.dqx.jp`.
 */

import type { APIRoute } from 'astro';

const isAllowedHost = (host: string): boolean =>
  host === 'dqx.jp' || host.endsWith('.dqx.jp');

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://hiroba.dqx.jp/',
};

const CACHE_CONTROL = 'public, max-age=604800, immutable';

// A localized request served from the *original* is provisional (the localized
// image can land at any time), so it must stay revalidatable rather than frozen.
const FALLBACK_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

export const GET: APIRoute = async ({ params, locals }) => {
  const path = params.path ?? '';
  const runtime = locals.runtime as { env: { IMAGES_BUCKET: R2Bucket } };

  const localized = path.startsWith('l10n/');
  const rel = localized ? path.split('/').slice(2).join('/') : path;

  const slash = rel.indexOf('/');
  const host = slash === -1 ? rel : rel.slice(0, slash);
  const rest = slash === -1 ? '' : rel.slice(slash + 1);

  if (!host || !rest || !isAllowedHost(host)) {
    return new Response('Forbidden', { status: 403 });
  }

  const bucket = runtime.env.IMAGES_BUCKET;
  const originalKey = `${host}/${rest}`;

  const preferred = localized ? await bucket.get(path) : null;
  const hit = preferred ?? (await bucket.get(originalKey));
  if (hit) {
    return new Response(hit.body, {
      headers: {
        'Content-Type':
          hit.httpMetadata?.contentType ?? 'application/octet-stream',
        'Cache-Control':
          localized && !preferred ? FALLBACK_CACHE_CONTROL : CACHE_CONTROL,
        ETag: hit.httpEtag,
      },
    });
  }

  // Miss → fetch the CDN original once, store it, serve it.
  let res: Response;
  try {
    res = await fetch(`https://${originalKey}`, { headers: FETCH_HEADERS });
  } catch (err) {
    console.warn(`img: upstream fetch failed for ${originalKey}:`, err);
    return new Response('Upstream unreachable', { status: 502 });
  }
  if (!res.ok) {
    return new Response('Upstream error', { status: res.status });
  }
  const contentType =
    res.headers.get('content-type') ?? 'application/octet-stream';
  const body = await res.arrayBuffer();

  await bucket.put(originalKey, body, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': localized ? FALLBACK_CACHE_CONTROL : CACHE_CONTROL,
    },
  });
};
