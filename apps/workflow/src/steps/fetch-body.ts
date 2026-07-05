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
  getTopic,
  newsItems,
  setItemFetchState,
  upsertTopic,
  type Database,
} from '@hiroba/db';
import { fetchNewsBody, fetchTopicBody } from '@hiroba/scraper';

import type { FetchBodyResult, ItemType } from '../types';

/** Fetch + save an article body, dispatching on item type. */
export function fetchAndSaveArticleBody(
  db: Database,
  itemType: ItemType,
  itemId: string,
): Promise<FetchBodyResult> {
  return itemType === 'topic'
    ? fetchAndSaveTopicBody(db, itemId)
    : fetchAndSaveNewsBody(db, itemId);
}

/**
 * Fetch and save body content for a news item. The row already exists (list
 * scraping seeds it); a fetched block tree is left untouched so a mid-pipeline
 * re-run is cheap.
 */
export async function fetchAndSaveNewsBody(
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

  // If the block tree already exists, skip fetching (and make sure the state
  // agrees — a re-run after a mid-pipeline failure lands here).
  if (item.blocksJa !== null) {
    await setItemFetchState(db, 'news', itemId, 'done');
    return { success: true, blockCount: item.blocksJa.length };
  }

  await setItemFetchState(db, 'news', itemId, 'running');

  try {
    // Fetch + parse the detail page into a block tree.
    const blocks = await fetchNewsBody(itemId);
    const now = Temporal.Now.instant();

    // Save to D1
    await db
      .update(newsItems)
      .set({
        blocksJa: blocks,
        bodyFetchedAt: now,
        fetchState: blocks.length > 0 ? 'done' : 'failed',
      })
      .where(eq(newsItems.id, itemId));

    return { success: blocks.length > 0, blockCount: blocks.length };
  } catch (error) {
    console.error(`Failed to fetch body for ${itemId}:`, error);
    await setItemFetchState(db, 'news', itemId, 'failed');
    return { success: false, blockCount: 0 };
  }
}

/**
 * Fetch and save body content for a topic. Unlike news, the row may not exist
 * yet, so this upserts — keeping an accurate published date if list scraping
 * seeded one, otherwise stamping now (the topics list scraper backfills later).
 */
export async function fetchAndSaveTopicBody(
  db: Database,
  itemId: string,
): Promise<FetchBodyResult> {
  // No-op for a topic not yet in D1 — the upsert below settles the state.
  await setItemFetchState(db, 'topic', itemId, 'running');
  const { titleJa, blocks } = await fetchTopicBody(itemId);
  const existing = await getTopic(db, itemId);
  await upsertTopic(db, {
    id: itemId,
    titleJa,
    publishedAt: existing?.publishedAt ?? Temporal.Now.instant(),
    blocksJa: blocks,
    bodyFetchedAt: Temporal.Now.instant(),
    fetchState: blocks.length > 0 ? 'done' : 'failed',
  });
  return { success: blocks.length > 0, blockCount: blocks.length };
}
