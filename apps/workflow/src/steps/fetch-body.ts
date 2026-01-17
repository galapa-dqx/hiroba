/**
 * Fetch body step - Scrape news content and save to D1.
 *
 * Reads the news item from D1, fetches the body HTML from hiroba.dqx.jp,
 * parses and cleans the text, and saves contentJa and bodyFetchedAt.
 */

import { eq } from 'drizzle-orm';

import { newsItems, type Database } from '@hiroba/db';
import { fetchNewsBody } from '@hiroba/scraper';

import type { FetchBodyResult } from '../types';

/**
 * Fetch and save body content for a news item.
 *
 * @param db - Database client
 * @param itemId - News item ID
 * @returns Result with success status and content length
 */
export async function fetchAndSaveBody(db: Database, itemId: string): Promise<FetchBodyResult> {
  // Check if item exists and if body is already fetched
  const item = await db
    .select({
      contentJa: newsItems.contentJa,
    })
    .from(newsItems)
    .where(eq(newsItems.id, itemId))
    .get();

  if (!item) {
    console.error(`News item ${itemId} not found`);
    return { success: false };
  }

  // If body already exists, skip fetching
  if (item.contentJa !== null) {
    return {
      success: true,
      contentLength: item.contentJa.length,
    };
  }

  try {
    // Fetch the body from hiroba.dqx.jp
    const body = await fetchNewsBody(itemId);
    const now = Math.floor(Date.now() / 1000);

    // Save to D1
    await db
      .update(newsItems)
      .set({
        contentJa: body.contentJa,
        bodyFetchedAt: now,
      })
      .where(eq(newsItems.id, itemId));

    return {
      success: true,
      contentLength: body.contentJa.length,
    };
  } catch (error) {
    console.error(`Failed to fetch body for ${itemId}:`, error);
    return { success: false };
  }
}
