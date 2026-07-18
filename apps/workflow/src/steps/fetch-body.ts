/**
 * Fetch body step — scrape a detail page into the block tree and save it.
 *
 * Both item types land their canonical JA content in `blocks_ja`: news rows are
 * seeded by list scraping and updated in place; topic rows are upserted (the
 * body scrape is often the first time we see a topic). The unified pipeline
 * dispatches on item type via `fetchAndSaveArticleBody`.
 */

import { eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import {
  getPlayguide,
  getTopic,
  newsItems,
  syncArticleImages,
  upsertPlayguide,
  upsertTopic,
  type Database,
} from '@hiroba/db';
import {
  fetchNewsBody,
  fetchPlayguideBody,
  fetchTopicBody,
} from '@hiroba/scraper';

import type { FetchBodyResult, ItemType } from '../types';

/** Fetch + save an article body, dispatching on item type. */
export function fetchAndSaveArticleBody(
  db: Database,
  itemType: ItemType,
  itemId: string,
): Promise<FetchBodyResult> {
  return itemType === 'topic'
    ? fetchAndSaveTopicBody(db, itemId)
    : itemType === 'playguide'
      ? fetchAndSavePlayguideBody(db, itemId)
      : fetchAndSaveNewsBody(db, itemId);
}

/**
 * Fetch and save body content for a news item. The row already exists (list
 * scraping seeds it); a fetched block tree is left untouched so a mid-pipeline
 * re-run is cheap.
 */
async function fetchAndSaveNewsBody(
  db: Database,
  itemId: string,
): Promise<FetchBodyResult> {
  // Check if item exists and if the body is already fetched
  const item = await db
    .select({
      blocksJa: newsItems.blocksJa,
    })
    .from(newsItems)
    .where(eq(newsItems.id, itemId))
    .get();

  if (!item) {
    console.error(`News item ${itemId} not found`);
    return { success: false, blockCount: 0 };
  }

  // If the block tree already exists, skip fetching — a re-run after a
  // mid-pipeline failure lands here. Still resync the article_images index
  // from the existing blocks: rows that predate the index self-heal on any
  // pipeline re-run this way, matching topics and playguides, whose
  // unconditional upserts resync every run.
  if (item.blocksJa !== null) {
    await syncArticleImages(db, 'news', itemId, item.blocksJa);
    return { success: true, blockCount: item.blocksJa.length };
  }

  try {
    // Fetch + parse the detail page into a block tree.
    const blocks = await fetchNewsBody(itemId);
    const now = Temporal.Now.instant();

    // Save to D1. The fetch counts as the first recheck poll.
    const result = await db
      .update(newsItems)
      .set({
        blocksJa: blocks,
        bodyFetchedAt: now,
        bodyCheckedAt: now,
      })
      .where(eq(newsItems.id, itemId))
      .returning({ id: newsItems.id });
    // Guarded like every blocks_ja writer: sync only when a row matched, so
    // no ghost index rows even if the item vanished since the check above.
    if (result.length > 0) {
      await syncArticleImages(db, 'news', itemId, blocks);
    }

    return { success: blocks.length > 0, blockCount: blocks.length };
  } catch (error) {
    console.error(`Failed to fetch body for ${itemId}:`, error);
    return { success: false, blockCount: 0 };
  }
}

/**
 * Fetch and save body content for a topic. Unlike news, the row may not exist
 * yet, so this upserts — keeping an accurate published date if list scraping
 * seeded one, otherwise stamping now (the topics list scraper backfills later).
 */
async function fetchAndSaveTopicBody(
  db: Database,
  itemId: string,
): Promise<FetchBodyResult> {
  const { titleJa, blocks } = await fetchTopicBody(itemId);
  const existing = await getTopic(db, itemId);
  const now = Temporal.Now.instant();
  await upsertTopic(db, {
    id: itemId,
    titleJa,
    publishedAt: existing?.publishedAt ?? now,
    blocksJa: blocks,
    bodyFetchedAt: now,
    // The fetch counts as the first recheck poll.
    bodyCheckedAt: now,
  });
  return { success: blocks.length > 0, blockCount: blocks.length };
}

/**
 * Fetch and save body content for a playguide. Like topics, the row may already
 * exist (crawl discovery seeds it) or not (direct view of an uncrawled slug), so
 * this upserts. Title resolution is a hybrid: the page's specific `h2.iconTitle`
 * wins when present, else the crawl-seeded anchor label is kept, else the
 * scraper's self-contained fallback (tit_icon / #cttTitle / slug).
 */
async function fetchAndSavePlayguideBody(
  db: Database,
  itemId: string,
): Promise<FetchBodyResult> {
  const { titleJa, specificTitle, blocks } = await fetchPlayguideBody(itemId);
  const existing = await getPlayguide(db, itemId);
  const now = Temporal.Now.instant();
  await upsertPlayguide(db, {
    id: itemId,
    titleJa: specificTitle ?? existing?.titleJa ?? titleJa,
    blocksJa: blocks,
    bodyFetchedAt: now,
    // The fetch counts as the first recheck poll.
    bodyCheckedAt: now,
  });
  return { success: blocks.length > 0, blockCount: blocks.length };
}
