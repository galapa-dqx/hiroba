/**
 * Cloudflare edge-cache purge — the "bust on change" half of the web caching
 * strategy. The web app caches complete article pages hard at the edge (long
 * `s-maxage`) and serves localized images with a multi-hour TTL; this is how a
 * re-translation, an inline edit, or an image regeneration shows up before that
 * TTL lapses.
 *
 * Best-effort and config-gated: without CF_ZONE_ID + CF_PURGE_TOKEN it logs and
 * no-ops, so the pipeline runs unchanged until the secrets are set. We purge by
 * exact URL (the `files` field), which works on every Cloudflare plan —
 * cache-tag and prefix purge are Enterprise-only, so we enumerate the per-
 * language URLs ourselves.
 */

import type { Database } from '@hiroba/db';

import type { Env, ItemType } from './types';

/** The slice of the worker env purging reads — narrow so flow bodies holding
 *  a Pick of Env (the platform-free test seam) can purge too. */
export type PurgeEnv = Pick<
  Env,
  'CF_ZONE_ID' | 'CF_PURGE_TOKEN' | 'WEB_BASE_URL' | 'IMAGE_BASE'
>;

/** Web detail-page path segment per item type (topics is plural in the route). */
const ARTICLE_PATH: Record<ItemType, string> = {
  news: 'news',
  topic: 'topics',
  playguide: 'playguide',
};

/** Cloudflare's cap on URLs per purge-by-file request. */
const PURGE_CHUNK = 30;

type PurgeLog = {
  warn(message: string): void;
  debug(message: string): void;
};

/** Every per-language detail URL for an article. */
function articleUrls(
  webBase: string,
  itemType: ItemType,
  id: string,
  languages: ReadonlyArray<{ code: string }>,
): string[] {
  const base = webBase.replace(/\/+$/, '');
  const path = ARTICLE_PATH[itemType];
  return languages.map((l) => `${base}/${l.code}/${path}/${id}`);
}

/**
 * Purge specific URLs from Cloudflare's edge cache, chunked to the per-request
 * cap. Never throws — a purge failure must not fail the pipeline step that
 * triggered it; it just means the content refreshes on its TTL instead.
 */
async function purgeUrls(
  env: PurgeEnv,
  urls: string[],
  log?: PurgeLog,
): Promise<void> {
  if (urls.length === 0) return;
  if (!env.CF_ZONE_ID || !env.CF_PURGE_TOKEN) {
    log?.warn(
      `Cache purge skipped (CF_ZONE_ID/CF_PURGE_TOKEN unset): ${urls.length} url(s)`,
    );
    return;
  }

  for (let i = 0; i < urls.length; i += PURGE_CHUNK) {
    const files = urls.slice(i, i + PURGE_CHUNK);
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.CF_PURGE_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ files }),
        },
      );
      if (res.ok) {
        log?.debug(`Purged ${files.length} url(s)`);
      } else {
        log?.warn(
          `Cache purge failed (${res.status}): ${await res.text().catch(() => '')}`,
        );
      }
    } catch (err) {
      log?.warn(
        `Cache purge error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Purge an article's detail page across every enabled language. */
export async function purgeArticle(
  env: PurgeEnv,
  itemType: ItemType,
  id: string,
  languages: ReadonlyArray<{ code: string }>,
  log?: PurgeLog,
): Promise<void> {
  if (!env.WEB_BASE_URL) {
    log?.warn('Cache purge skipped (WEB_BASE_URL unset)');
    return;
  }
  await purgeUrls(
    env,
    articleUrls(env.WEB_BASE_URL, itemType, id, languages),
    log,
  );
}

/**
 * Purge every page that renders a given image in a given language — the
 * fan-out after an admin regenerates or uploads a localized image. Localized
 * images live at versioned immutable URLs, so the image itself never needs
 * purging; what's stale is the HTML embedding the *previous* version's URL:
 * the article pages carrying the image (via the article_images reverse index)
 * and the home page when it backs a rotation banner. Only the target
 * language's pages change, so only they are purged.
 */
export async function purgeImagePages(
  env: PurgeEnv,
  db: Database,
  imageKey: string,
  language: string,
  log?: PurgeLog,
): Promise<void> {
  if (!env.WEB_BASE_URL) {
    log?.warn('Cache purge skipped (WEB_BASE_URL unset)');
    return;
  }
  const base = env.WEB_BASE_URL.replace(/\/+$/, '');
  // The article_images reverse index: every article whose block tree embeds
  // this image.
  const articles = await db.query.articleImages.findMany({
    columns: { itemType: true, itemId: true },
    where: { imageKey },
  });
  const urls = articles.map(
    (a) =>
      `${base}/${language}/${ARTICLE_PATH[a.itemType as ItemType]}/${a.itemId}`,
  );
  const banner = await db.query.banners.findFirst({
    columns: { imageKey: true },
    where: { imageKey },
  });
  if (banner) {
    // The home page renders the banner carousel; purge both slash variants
    // since the edge caches whichever shape was requested.
    urls.push(`${base}/${language}`, `${base}/${language}/`);
  }
  await purgeUrls(env, urls, log);
}
