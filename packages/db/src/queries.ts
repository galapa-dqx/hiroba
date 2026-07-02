/**
 * Database queries for news items.
 */

import { and, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import { getNextCheckTime, isDueForCheck, type Category } from '@hiroba/shared';

import type { Block } from '@hiroba/richtext';

import type { Database } from './client';
import { newsItems, type ListItem, type NewsItem } from './schema/news-items';
import { topics, type NewTopic, type Topic } from './schema/topics';
import { translations, type TranslationField } from './schema/translations';

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

/* ------------------------------------------------------------------ *
 * Topics
 * ------------------------------------------------------------------ */

/**
 * Upsert a topic. On conflict, updates only the columns present on `topic`
 * (title/publishedAt always; category/blocksJa/bodyFetchedAt when provided) so a
 * metadata re-upsert never clobbers an already-fetched block tree.
 */
export async function upsertTopic(db: Database, topic: NewTopic): Promise<void> {
  const set: Partial<NewTopic> = {
    titleJa: topic.titleJa,
    publishedAt: topic.publishedAt,
  };
  if (topic.category !== undefined) set.category = topic.category;
  if (topic.blocksJa !== undefined) set.blocksJa = topic.blocksJa;
  if (topic.bodyFetchedAt !== undefined) set.bodyFetchedAt = topic.bodyFetchedAt;

  await db
    .insert(topics)
    .values(topic)
    .onConflictDoUpdate({ target: topics.id, set });
}

/**
 * Get a single topic by ID.
 */
export async function getTopic(db: Database, id: string): Promise<Topic | null> {
  const result = await db.select().from(topics).where(eq(topics.id, id)).get();
  return result ?? null;
}

/**
 * Get paginated list of topics (mirrors getNewsItems).
 */
export async function getTopics(
  db: Database,
  options: {
    category?: string;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ items: Topic[]; hasMore: boolean; nextCursor?: string }> {
  const limit = Math.min(options.limit ?? 20, 100);

  const conditions = [];
  if (options.category) {
    conditions.push(eq(topics.category, options.category));
  }
  if (options.cursor) {
    conditions.push(lt(topics.publishedAt, Temporal.Instant.from(options.cursor)));
  }

  const results = await db
    .select()
    .from(topics)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(topics.publishedAt))
    .limit(limit + 1)
    .all();

  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, -1) : results;

  return {
    items,
    hasMore,
    nextCursor: hasMore ? items[items.length - 1].publishedAt.toString() : undefined,
  };
}

/**
 * Get the localized title + block tree for a topic, if translated.
 * The `content` translation stores the block tree as a JSON blob.
 */
export async function getTopicTranslations(
  db: Database,
  id: string,
  language: string = 'en',
): Promise<{ title: string | null; blocks: Block[] | null }> {
  const rows = await db
    .select()
    .from(translations)
    .where(
      and(
        eq(translations.itemType, 'topic'),
        eq(translations.itemId, id),
        eq(translations.language, language),
      ),
    )
    .all();

  let title: string | null = null;
  let blocks: Block[] | null = null;
  for (const row of rows) {
    if (row.field === 'title') {
      title = row.value;
    } else if (row.field === 'content') {
      try {
        blocks = JSON.parse(row.value) as Block[];
      } catch {
        blocks = null;
      }
    }
  }
  return { title, blocks };
}

/**
 * Upsert a single topic translation row (itemType='topic').
 * For field='content', pass the block tree pre-serialized to JSON.
 */
export async function upsertTopicTranslation(
  db: Database,
  params: {
    itemId: string;
    language: string;
    field: TranslationField;
    value: string;
    model: string;
  },
): Promise<void> {
  const now = Temporal.Now.instant();
  await db
    .insert(translations)
    .values({
      itemType: 'topic',
      itemId: params.itemId,
      language: params.language,
      field: params.field,
      value: params.value,
      translatedAt: now,
      model: params.model,
    })
    .onConflictDoUpdate({
      target: [
        translations.itemType,
        translations.itemId,
        translations.language,
        translations.field,
      ],
      set: { value: params.value, translatedAt: now, model: params.model },
    });
}
