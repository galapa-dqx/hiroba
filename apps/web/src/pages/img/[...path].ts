/**
 * Image serving — R2-backed, self-healing.
 *
 *   /img/<host>/<path>            → the mirrored original (R2 key `<host>/<path>`)
 *   /img/l10n/<lang>/<host>/<path> → the localized image (R2 key `l10n/<lang>/…`),
 *                                    falling back to the original when a given
 *                                    image was never localized.
 *
 * On a total miss we fetch the DQX CDN once, store the original, and serve it —
 * so the second view is a pure R2 read. Host is allowlisted to `*.dqx.jp`.
 */

import type { APIRoute } from 'astro';

const isAllowedHost = (host: string): boolean =>
  host === 'dqx.jp' || host.endsWith('.dqx.jp');

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://hiroba.dqx.jp/',
};

const CACHE_CONTROL = 'public, max-age=604800, immutable';

// Caching for a localized request served from the *original* — i.e. the
// localized image doesn't exist (yet, or ever). That substitution is
// provisional: the localized image can land at any time, so the response must
// stay revalidatable. `immutable` here would freeze the Japanese original under
// the l10n URL in the browser and any edge cache for a week, so the English
// version would never appear even once it exists.
const FALLBACK_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

export const GET: APIRoute = async ({ params, locals }) => {
  const path = params.path ?? '';

  // A localized request carries an `l10n/<lang>/` prefix; the rest is the
  // original `<host>/<path>`. Non-localized requests are just `<host>/<path>`.
  const localized = path.startsWith('l10n/');
  const rel = localized ? path.split('/').slice(2).join('/') : path;

  const slash = rel.indexOf('/');
  const host = slash === -1 ? rel : rel.slice(0, slash);
  const rest = slash === -1 ? '' : rel.slice(slash + 1);

  if (!host || !rest || !isAllowedHost(host)) {
    return new Response('Forbidden', { status: 403 });
  }

  const bucket = locals.runtime.env.IMAGES_BUCKET;
  const originalKey = `${host}/${rest}`;

  // 1. Preferred object: the localized one if this is an l10n request, else the
  //    original. 2. Fall back to the original (an image not localized — yet, or
  //    ever). A fallback served under an l10n URL is provisional, so it must not
  //    be cached as immutable (see FALLBACK_CACHE_CONTROL).
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

  // 3. Miss → fetch the CDN original once, store it, serve it.
  let res: Response;
  try {
    res = await fetch(`https://${originalKey}`, { headers: FETCH_HEADERS });
  } catch (err) {
    // Unresolvable/unreachable upstream (e.g. a corrupted host that slipped
    // through) — fail cleanly instead of surfacing an unhandled fetch rejection.
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
      // A localized request reaching here is serving the just-fetched original
      // as a fallback — keep it revalidatable, not immutable.
      'Cache-Control': localized ? FALLBACK_CACHE_CONTROL : CACHE_CONTROL,
    },
  });
};
