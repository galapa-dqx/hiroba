/**
 * Database queries for news items.
 */

import { and, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import { getNextCheckTime, isDueForCheck, type Category } from '@hiroba/shared';

import type { Database } from './client';
import { newsItems, type ListItem, type NewsItem } from './schema/news-items';
import { translations } from './schema/translations';

/**
 * Upsert news items from list scraping.
 * Returns items that were newly inserted (not updates to existing).
 */
export async function upsertListItems(
  db: Database,
  items: ListItem[],
): Promise<ListItem[]> {
  const newlyInserted: ListItem[] = [];

  for (const item of items) {
    const existing = await db
      .select({ id: newsItems.id })
      .from(newsItems)
      .where(eq(newsItems.id, item.id))
      .get();

    await db
      .insert(newsItems)
      .values({
        id: item.id,
        titleJa: item.titleJa,
        category: item.category,
        publishedAt: item.publishedAt,
      })
      .onConflictDoNothing();

    if (!existing) {
      newlyInserted.push(item);
    }
  }

  return newlyInserted;
}

/**
 * Get paginated list of news items.
 */
export async function getNewsItems(
  db: Database,
  options: {
    category?: Category;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ items: NewsItem[]; hasMore: boolean; nextCursor?: string }> {
  const limit = Math.min(options.limit ?? 20, 100);

  const conditions = [];

  if (options.category) {
    conditions.push(eq(newsItems.category, options.category));
  }

  if (options.cursor) {
    const cursorInstant = Temporal.Instant.from(options.cursor);
    conditions.push(lt(newsItems.publishedAt, cursorInstant));
  }

  const query = db
    .select()
    .from(newsItems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(newsItems.publishedAt))
    .limit(limit + 1);

  const results = await query.all();
  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, -1) : results;

  return {
    items,
    hasMore,
    nextCursor: hasMore
      ? items[items.length - 1].publishedAt.toString()
      : undefined,
  };
}

/**
 * Get a single news item by ID.
 */
export async function getNewsItem(
  db: Database,
  id: string,
): Promise<NewsItem | null> {
  const result = await db
    .select()
    .from(newsItems)
    .where(eq(newsItems.id, id))
    .get();
  return result ?? null;
}

/**
 * Get stats for admin dashboard.
 */
export async function getStats(db: Database): Promise<{
  totalItems: number;
  itemsWithBody: number;
  itemsWithBodyFetchedAt: number;
  itemsTranslated: number;
  itemsPendingRecheck: number;
  byCategory: Record<string, number>;
}> {
  const [totalResult, withBodyResult, translatedResult, categoryResults] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(newsItems)
        .get(),
      db
        .select({ count: sql<number>`count(*)` })
        .from(newsItems)
        .where(isNotNull(newsItems.contentJa))
        .get(),
      db
        .select({ count: sql<number>`count(DISTINCT item_id)` })
        .from(translations)
        .where(
          and(
            eq(translations.itemType, 'news'),
            eq(translations.language, 'en'),
          ),
        )
        .get(),
      db
        .select({
          category: newsItems.category,
          count: sql<number>`count(*)`,
        })
        .from(newsItems)
        .groupBy(newsItems.category)
        .all(),
    ]);

  const itemsWithFetchedBody = await db
    .select({
      publishedAt: newsItems.publishedAt,
      bodyFetchedAt: newsItems.bodyFetchedAt,
    })
    .from(newsItems)
    .where(isNotNull(newsItems.bodyFetchedAt))
    .all();

  const itemsPendingRecheck = itemsWithFetchedBody.filter((item) =>
    isDueForCheck(item.publishedAt, item.bodyFetchedAt),
  ).length;

  const byCategory: Record<string, number> = {};
  for (const row of categoryResults) {
    byCategory[row.category] = row.count;
  }

  return {
    totalItems: totalResult?.count ?? 0,
    itemsWithBody: withBodyResult?.count ?? 0,
    itemsWithBodyFetchedAt: itemsWithFetchedBody.length,
    itemsTranslated: translatedResult?.count ?? 0,
    itemsPendingRecheck,
    byCategory,
  };
}

/**
 * Get items due for body recheck, sorted by next check time.
 */
export async function getRecheckQueue(
  db: Database,
  limit: number = 50,
): Promise<
  Array<{
    id: string;
    titleJa: string;
    category: string;
    publishedAt: Temporal.Instant;
    bodyFetchedAt: Temporal.Instant;
    nextCheckAt: Temporal.Instant;
  }>
> {
  const items = await db
    .select()
    .from(newsItems)
    .where(isNotNull(newsItems.bodyFetchedAt))
    .all();

  const now = Temporal.Now.instant();

  return items
    .map((item) => ({
      id: item.id,
      titleJa: item.titleJa,
      category: item.category,
      publishedAt: item.publishedAt,
      bodyFetchedAt: item.bodyFetchedAt!,
      nextCheckAt: getNextCheckTime(item.publishedAt, item.bodyFetchedAt!),
    }))
    .filter((item) => Temporal.Instant.compare(item.nextCheckAt, now) <= 0)
    .sort((a, b) => Temporal.Instant.compare(a.nextCheckAt, b.nextCheckAt))
    .slice(0, limit);
}

/**
 * Invalidate cached body content for a news item.
 */
export async function invalidateBody(
  db: Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .update(newsItems)
    .set({
      contentJa: null,
      bodyFetchedAt: null,
    })
    .where(eq(newsItems.id, id))
    .returning({ id: newsItems.id });

  return result.length > 0;
}
