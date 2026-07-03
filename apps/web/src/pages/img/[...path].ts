/**
 * Image proxy — `/img/<host>/<path>` → `https://<host>/<path>`.
 *
 * rewriteImageSrc encodes the upstream host as the first path segment; this route
 * reconstructs the URL and streams it back (with a browser UA/Referer, since the
 * DQX CDN blocks hotlinks). Host is allowlisted to `*.dqx.jp` so it can't be an
 * open proxy. R2 caching is a later optimization; for now it proxies directly with
 * a long-lived Cache-Control so the CDN/browser caches it.
 */

import type { APIRoute } from 'astro';

const isAllowedHost = (host: string): boolean => host === 'dqx.jp' || host.endsWith('.dqx.jp');

export const GET: APIRoute = async ({ params, request }) => {
  const path = params.path ?? '';
  const slash = path.indexOf('/');
  const host = slash === -1 ? path : path.slice(0, slash);
  const rest = slash === -1 ? '' : path.slice(slash + 1);

  if (!host || !isAllowedHost(host)) {
    return new Response('Forbidden', { status: 403 });
  }

  const search = new URL(request.url).search;
  const upstream = `https://${host}/${rest}${search}`;

  const res = await fetch(upstream, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://hiroba.dqx.jp/',
    },
  });

  if (!res.ok) {
    return new Response('Upstream error', { status: res.status });
  }

  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type': res.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  });
};
