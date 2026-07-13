/**
 * Cache-Control policy for the web app's SSR responses.
 *
 * Cloudflare edge-caches these via a zone Cache Rule (Edge TTL = "respect
 * origin headers"), so `s-maxage` is the real cost lever — it keeps the Worker
 * and D1 off the path for repeat traffic — while `max-age` is the browser's
 * (shorter) private copy. Content that changes out of band (an article's
 * re-translation, an image regeneration) is purged by URL from the pipeline
 * (see apps/workflow/src/purge.ts), so article TTLs can run long: the purge,
 * not the clock, is the freshness path. TTLs are the backstop for a missed
 * purge, not the primary mechanism.
 *
 * Pages set their own header via `Astro.response.headers`; the middleware fills
 * CACHE_LIST as the default for anything that doesn't (the list/index pages).
 */

/**
 * Lists and indexes (home, category, topics/playguide index). These recompose
 * whenever any child item lands, and we don't purge them individually, so a
 * short shared TTL keeps them fresh without hammering D1 on every hit.
 */
export const CACHE_LIST =
  'public, max-age=60, s-maxage=600, stale-while-revalidate=3600';

/**
 * A fully-complete article: static until it's re-translated, edited, or one of
 * its images is re-rendered — and purged by URL when any of those happen, so
 * cache it hard at the edge. The 6h `s-maxage` (not longer) bounds how long a
 * *missed* purge can pin the page — and with it the previous versioned image
 * URLs it embeds; the 5min `max-age` is what makes a successful purge reach
 * returning readers within minutes.
 */
export const CACHE_ARTICLE_COMPLETE =
  'public, max-age=300, s-maxage=21600, stale-while-revalidate=21600';

/**
 * A settled-but-degraded article (e.g. an image that failed to localize) still
 * self-heals in the background, so keep the edge copy short — a heal should
 * surface on its own within minutes rather than waiting on a purge.
 */
export const CACHE_ARTICLE_DEGRADED =
  'public, max-age=60, s-maxage=600, stale-while-revalidate=3600';

/**
 * A still-processing article, or a hard 404: never cache. The body isn't shown
 * yet (the SSE stream drives the update), and a 404 id might later become real
 * for lazily-fetched types.
 */
export const CACHE_NONE = 'no-store';

/**
 * Calendar: expire on the next top-of-the-hour rather than a fixed hour from
 * whenever the copy happened to be cached, so every edge copy rolls over to the
 * new game day *together* at JST midnight (00:00 JST = 15:00 UTC, itself an
 * hour boundary) instead of up to an hour late. No stale-while-revalidate —
 * serving the previous day across the boundary is exactly what we're avoiding.
 *
 * @param nowEpochSeconds current time in epoch seconds (Temporal.Now.instant().epochSeconds)
 */
export function cacheCalendar(nowEpochSeconds: number): string {
  const secs = 3600 - (Math.floor(nowEpochSeconds) % 3600);
  return `public, max-age=${secs}, s-maxage=${secs}`;
}
