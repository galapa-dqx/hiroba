/**
 * Fetch body step - scrape a news detail page into the block tree and save it.
 *
 * Reads the news item from D1, and if the body hasn't been fetched yet, fetches
 * the detail page from hiroba.dqx.jp, parses it into blocks_ja (the
 * @hiroba/richtext tree), and stamps bodyFetchedAt.
 */

import { eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import { newsItems, type Database } from '@hiroba/db';
import { fetchNewsBody } from '@hiroba/scraper';

import type { FetchBodyResult } from '../types';

/**
 * Fetch and save body content for a news item.
 *
 * @param db - Database client
 * @param itemId - News item ID
 * @returns Result with success status and parsed block count
 */
export async function fetchAndSaveBody(
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
    return { success: false };
  }

  // If the block tree already exists, skip fetching.
  if (item.blocksJa !== null) {
    return {
      success: true,
      contentLength: item.blocksJa.length,
    };
  }

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
      })
      .where(eq(newsItems.id, itemId));

    return {
      success: blocks.length > 0,
      contentLength: blocks.length,
    };
  } catch (error) {
    console.error(`Failed to fetch body for ${itemId}:`, error);
    return { success: false };
  }
}
