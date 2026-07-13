/**
 * Image serving for the admin panel — R2-backed, self-healing. Same contract as
 * the web worker's `/img` route so the Images screen can reference stored images
 * without reaching across origins:
 *
 *   /img/<host>/<path>                    → the mirrored original (R2 key `<host>/<path>`)
 *   /img/l10n/<lang>/v<ts>/<host>/<path>  → a versioned localized render (immutable)
 *   /img/l10n/<lang>/<host>/<path>        → a legacy unversioned localized image,
 *                                           falling back to the original when a
 *                                           given image was never localized.
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

// Mutable localized responses stay revalidatable rather than frozen: a legacy
// (unversioned) l10n hit was replaced in place historically, and a fallback
// (served from the original) is provisional — the localized image can land at
// any time. Versioned renders are immutable and use CACHE_CONTROL like the
// originals. The ETag makes the revalidation a cheap 304 in practice.
const MUTABLE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

export const GET: APIRoute = async ({ params, locals, request }) => {
  const path = params.path ?? '';
  const runtime = locals.runtime as { env: { IMAGES_BUCKET: R2Bucket } };

  const localized = path.startsWith('l10n/');
  let rel = path;
  let versioned = false;
  if (localized) {
    const segs = path.split('/');
    versioned = /^v[0-9a-z]+$/.test(segs[2] ?? '');
    rel = segs.slice(versioned ? 3 : 2).join('/');
  }

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
    // Immutable when the object can never change under this URL: originals
    // (content-keyed) and versioned localized renders served as themselves.
    const cacheControl =
      !localized || (versioned && preferred)
        ? CACHE_CONTROL
        : MUTABLE_CACHE_CONTROL;
    if (request.headers.get('If-None-Match') === hit.httpEtag) {
      return new Response(null, {
        status: 304,
        headers: { 'Cache-Control': cacheControl, ETag: hit.httpEtag },
      });
    }
    return new Response(hit.body, {
      headers: {
        'Content-Type':
          hit.httpMetadata?.contentType ?? 'application/octet-stream',
        'Cache-Control': cacheControl,
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
      'Cache-Control': localized ? MUTABLE_CACHE_CONTROL : CACHE_CONTROL,
    },
  });
};
