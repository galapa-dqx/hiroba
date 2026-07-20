/**
 * Database queries for news items.
 */

import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Temporal } from 'temporal-polyfill';

import { collectImages, imageKey, type Block } from '@hiroba/richtext';
import {
  getNextCheckTime,
  type Category,
  type PhaseState,
} from '@hiroba/shared';

import type { Database } from './client';
import {
  buildResetEvents,
  RESET_SOURCE_TYPE,
  type ResetTitleMap,
} from './reset-events';
import { articleImages } from './schema/article-images';
import { banners } from './schema/banners';
import {
  events,
  eventSources,
  type Event,
  type NewEvent,
} from './schema/events';
import { images, type Image } from './schema/images';
import { getEnabledLanguages } from './schema/languages';
import { newsItems, type ListItem, type NewsItem } from './schema/news-items';
import {
  playguides,
  type NewPlayguide,
  type Playguide,
} from './schema/playguides';
import {
  resetMilestones,
  type NewResetMilestone,
} from './schema/reset-milestones';
import { topics, type NewTopic, type Topic } from './schema/topics';
import {
  translations,
  type ItemType,
  type Translation,
  type TranslationField,
} from './schema/translations';

/**
 * D1 caps bound parameters at ~100 per statement, so any query that fans a
 * caller-supplied list into `IN (?, ?, …)` must run in slices. 50 leaves
 * headroom for the query's other parameters.
 */
const IN_CHUNK = 50;

/** Run `fn` over `items` in IN_CHUNK-sized slices and concatenate the results. */
async function chunked<T, R>(
  items: T[],
  fn: (slice: T[]) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) {
    out.push(...(await fn(items.slice(i, i + IN_CHUNK))));
  }
  return out;
}

/** The three body-bearing article types, sharing the pipeline (news/topic/playguide). */
export type ArticleType = 'news' | 'topic' | 'playguide';

/**
 * The source table for a body-bearing item type. All three share the columns the
 * pipeline touches (id, titleJa, blocksJa, body* tracking); callers
 * that reach for a type-specific column (news `category`, dated `publishedAt`)
 * branch explicitly instead of going through here.
 */
function articleTable(itemType: ArticleType) {
  return itemType === 'news'
    ? newsItems
    : itemType === 'topic'
      ? topics
      : playguides;
}

/**
 * D1 caps bound parameters at 100 per query; 16 rows of a handful of bound
 * ListItem columns keeps comfortable headroom under the cap.
 */
const UPSERT_LIST_CHUNK = 16;

/**
 * Upsert news items from list scraping.
 * Returns items that were newly inserted (not updates to existing).
 *
 * Single `INSERT … ON CONFLICT DO NOTHING RETURNING` per chunk — "newly
 * inserted" is decided by the conflict resolution itself, atomically. The
 * previous per-item SELECT-then-INSERT could count one item as new twice
 * when concurrent scrape pages carried it (a publish mid-backfill shifts the
 * newest-first archive across page boundaries).
 */
export async function upsertListItems(
  db: Database,
  items: ListItem[],
): Promise<ListItem[]> {
  if (items.length === 0) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const inserted: ListItem[] = [];
  for (let i = 0; i < items.length; i += UPSERT_LIST_CHUNK) {
    const chunk = items.slice(i, i + UPSERT_LIST_CHUNK);
    const rows = await db
      .insert(newsItems)
      .values(
        chunk.map((item) => ({
          id: item.id,
          titleJa: item.titleJa,
          category: item.category,
          publishedAt: item.publishedAt,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: newsItems.id });
    for (const row of rows) {
      const item = byId.get(row.id);
      if (item) inserted.push(item);
    }
  }
  return inserted;
}

/** A news item plus its resolved current-language title (null ⇒ show titleJa). */
export type LocalizedNewsItem = NewsItem & { titleEn: string | null };

/**
 * Get paginated list of news items, each carrying its current-language title
 * (`titleEn`) joined from the translations table so lists read in the target
 * language before the article is ever opened (DQX-11).
 *
 * The join is one-to-one — the translations PK is unique per
 * (item_type, item_id, language, field) — so it never multiplies rows. `titleEn`
 * is null when no translation exists yet; a stale value from an in-flight
 * re-translation is still the best thing to render, so the row's state is not
 * filtered (mirrors the detail page).
 */
export async function getNewsItems(
  db: Database,
  options: {
    category?: Category;
    limit?: number;
    cursor?: string;
    language?: string;
  } = {},
): Promise<{
  items: LocalizedNewsItem[];
  hasMore: boolean;
  nextCursor?: string;
}> {
  const limit = Math.min(options.limit ?? 20, 100);
  const language = options.language ?? 'en';

  const conditions = [];

  if (options.category) {
    conditions.push(eq(newsItems.category, options.category));
  }

  if (options.cursor) {
    const cursorInstant = Temporal.Instant.from(options.cursor);
    conditions.push(lt(newsItems.publishedAt, cursorInstant));
  }

  const query = db
    .select({
      ...getTableColumns(newsItems),
      titleEn: translations.value,
    })
    .from(newsItems)
    .leftJoin(
      translations,
      and(
        eq(translations.itemType, 'news'),
        eq(translations.itemId, newsItems.id),
        eq(translations.language, language),
        eq(translations.field, 'title'),
      ),
    )
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
 * Fetch `{id, titleJa}` for a set of items of one type — the input the title
 * translation workflow needs (its params carry only ids, so it reads current
 * titles here). Missing ids are simply omitted.
 */
export async function getItemTitles(
  db: Database,
  itemType: ArticleType,
  ids: string[],
): Promise<Array<{ id: string; titleJa: string }>> {
  if (ids.length === 0) return [];
  const table = articleTable(itemType);
  return chunked(ids, (slice) =>
    db
      .select({ id: table.id, titleJa: table.titleJa })
      .from(table)
      .where(inArray(table.id, slice))
      .all(),
  );
}

/**
 * The newest `limit` items whose title is not yet translated into `language` —
 * the page the DQX-13 backfill workflow chews through. "Not translated" is a
 * left join with no value on the (item, language, title) row, so it catches
 * both items with no translation row at all and rows still in flight
 * (`running`/`pending` never carry a value); a `done` row always has a value,
 * so it drops out — that's what makes the backfill idempotent and re-runnable.
 *
 * Ordered newest-first (published desc, id desc as a stable tie-break) so the
 * archive fills in the order readers are most likely to want it. There is no
 * cursor: each translated title gains a value and leaves this set, so calling
 * again returns the next-newest untranslated page. The workflow relies on that
 * drop-out to advance and stops when a page makes no progress.
 */
export async function getUntranslatedTitles(
  db: Database,
  itemType: ArticleType,
  language: string,
  limit = 100,
): Promise<Array<{ id: string; titleJa: string }>> {
  const table = articleTable(itemType);
  // Playguides have no publish date; order by their crawl order instead so the
  // backfill still walks them in a stable sequence.
  const order =
    itemType === 'playguide'
      ? [asc(playguides.sortOrder), asc(playguides.id)]
      : [desc(table.publishedAt), desc(table.id)];

  return db
    .select({ id: table.id, titleJa: table.titleJa })
    .from(table)
    .leftJoin(
      translations,
      and(
        eq(translations.itemType, itemType),
        eq(translations.itemId, table.id),
        eq(translations.language, language),
        eq(translations.field, 'title'),
      ),
    )
    .where(isNull(translations.value))
    .orderBy(...order)
    .limit(Math.min(limit, 500))
    .all();
}

/* ------------------------------------------------------------------ *
 * Recheck scheduling (news + topics)
 * ------------------------------------------------------------------ */

/** One article in the recheck domain (its body has been fetched at least once). */
export type RecheckEntry = {
  itemType: ArticleType;
  id: string;
  titleJa: string;
  category: string | null;
  publishedAt: Temporal.Instant;
  /** Last observed content change (publication when never seen to change). */
  lastChangedAt: Temporal.Instant;
  /** Last time the source page was polled. */
  bodyCheckedAt: Temporal.Instant;
  /** Next due poll — null once retired (quiet past the retirement horizon). */
  nextCheckAt: Temporal.Instant | null;
};

/** Every fetched article of both types, with its recheck schedule computed. */
async function collectRecheckEntries(
  db: Database,
  now: Temporal.Instant,
): Promise<RecheckEntry[]> {
  const [news, topicRows, playguideRows] = await Promise.all([
    db
      .select({
        id: newsItems.id,
        titleJa: newsItems.titleJa,
        category: newsItems.category,
        publishedAt: newsItems.publishedAt,
        bodyFetchedAt: newsItems.bodyFetchedAt,
        bodyCheckedAt: newsItems.bodyCheckedAt,
        bodyChangedAt: newsItems.bodyChangedAt,
      })
      .from(newsItems)
      .where(isNotNull(newsItems.bodyFetchedAt))
      .all(),
    db
      .select({
        id: topics.id,
        titleJa: topics.titleJa,
        category: topics.category,
        publishedAt: topics.publishedAt,
        bodyFetchedAt: topics.bodyFetchedAt,
        bodyCheckedAt: topics.bodyCheckedAt,
        bodyChangedAt: topics.bodyChangedAt,
      })
      .from(topics)
      .where(isNotNull(topics.bodyFetchedAt))
      .all(),
    db
      .select({
        id: playguides.id,
        titleJa: playguides.titleJa,
        publishedAt: playguides.publishedAt,
        bodyFetchedAt: playguides.bodyFetchedAt,
        bodyCheckedAt: playguides.bodyCheckedAt,
        bodyChangedAt: playguides.bodyChangedAt,
      })
      .from(playguides)
      .where(isNotNull(playguides.bodyFetchedAt))
      .all(),
  ]);

  const toEntry = (
    itemType: ArticleType,
    row: {
      id: string;
      titleJa: string;
      category?: string | null;
      // Playguides have no publish date; the change anchor falls back to the
      // fetch time (which is non-null for anything in the recheck domain).
      publishedAt: Temporal.Instant | null;
      bodyFetchedAt: Temporal.Instant | null;
      bodyCheckedAt: Temporal.Instant | null;
      bodyChangedAt: Temporal.Instant | null;
    },
  ): RecheckEntry => {
    const anchor = row.publishedAt ?? row.bodyFetchedAt!;
    const lastChangedAt = row.bodyChangedAt ?? anchor;
    const bodyCheckedAt = row.bodyCheckedAt ?? row.bodyFetchedAt!;
    return {
      itemType,
      id: row.id,
      titleJa: row.titleJa,
      category: row.category ?? null,
      publishedAt: anchor,
      lastChangedAt,
      bodyCheckedAt,
      nextCheckAt: getNextCheckTime(lastChangedAt, bodyCheckedAt, now),
    };
  };

  return [
    ...news.map((row) => toEntry('news', row)),
    ...topicRows.map((row) => toEntry('topic', row)),
    ...playguideRows.map((row) => toEntry('playguide', row)),
  ];
}

export type RecheckQueue = {
  /** Due now, most overdue first. */
  due: RecheckEntry[];
  /** Scheduled in the future, soonest first. */
  upcoming: RecheckEntry[];
  /** Articles quiet past the retirement horizon — no longer checked. */
  retired: number;
};

/**
 * The recheck queue for the admin page: due items, the next scheduled checks,
 * and how many articles have been retired from checking.
 */
export async function getRecheckQueue(
  db: Database,
  options: { dueLimit?: number; upcomingLimit?: number } = {},
): Promise<RecheckQueue> {
  const dueLimit = options.dueLimit ?? 100;
  const upcomingLimit = options.upcomingLimit ?? 25;
  const now = Temporal.Now.instant();

  const entries = await collectRecheckEntries(db, now);
  const due: RecheckEntry[] = [];
  const upcoming: RecheckEntry[] = [];
  let retired = 0;

  for (const entry of entries) {
    if (entry.nextCheckAt === null) retired++;
    else if (Temporal.Instant.compare(entry.nextCheckAt, now) <= 0)
      due.push(entry);
    else upcoming.push(entry);
  }

  const byNextCheck = (a: RecheckEntry, b: RecheckEntry) =>
    Temporal.Instant.compare(a.nextCheckAt!, b.nextCheckAt!);
  due.sort(byNextCheck);
  upcoming.sort(byNextCheck);

  return {
    due: due.slice(0, dueLimit),
    upcoming: upcoming.slice(0, upcomingLimit),
    retired,
  };
}

/**
 * Due rechecks for the cron consumer, most overdue first, with the stored
 * block tree loaded for change detection.
 */
export async function getDueRechecks(
  db: Database,
  limit: number,
): Promise<Array<RecheckEntry & { blocksJa: Block[] | null }>> {
  const { due } = await getRecheckQueue(db, {
    dueLimit: limit,
    upcomingLimit: 0,
  });

  const out: Array<RecheckEntry & { blocksJa: Block[] | null }> = [];
  for (const entry of due) {
    const table = articleTable(entry.itemType);
    const row = await db
      .select({ blocksJa: table.blocksJa })
      .from(table)
      .where(eq(table.id, entry.id))
      .get();
    out.push({ ...entry, blocksJa: row?.blocksJa ?? null });
  }
  return out;
}

/** Record that a recheck poll found no change. */
export async function setBodyChecked(
  db: Database,
  itemType: ArticleType,
  id: string,
  at: Temporal.Instant = Temporal.Now.instant(),
): Promise<void> {
  const table = articleTable(itemType);
  await db.update(table).set({ bodyCheckedAt: at }).where(eq(table.id, id));
}

/**
 * Record that a recheck poll found changed content: store the fresh block
 * tree (un-annotated — the pipeline re-tags it) and reset the change anchor
 * so frequent checking resumes.
 */
export async function saveChangedBody(
  db: Database,
  itemType: ArticleType,
  id: string,
  params: { blocks: Block[]; titleJa?: string },
  at: Temporal.Instant = Temporal.Now.instant(),
): Promise<void> {
  const table = articleTable(itemType);
  const set: {
    blocksJa: Block[];
    bodyFetchedAt: Temporal.Instant;
    bodyCheckedAt: Temporal.Instant;
    bodyChangedAt: Temporal.Instant;
    titleJa?: string;
  } = {
    blocksJa: params.blocks,
    bodyFetchedAt: at,
    bodyCheckedAt: at,
    bodyChangedAt: at,
  };
  if (params.titleJa) set.titleJa = params.titleJa;
  const result = await db
    .update(table)
    .set(set)
    .where(eq(table.id, id))
    .returning({ id: table.id });
  if (result.length > 0) {
    await syncArticleImages(db, itemType, id, params.blocks);
  }
}

/* ------------------------------------------------------------------ *
 * Admin stats
 * ------------------------------------------------------------------ */

export type ArticleTypeStats = {
  total: number;
  withBody: number;
  /** Items with a finished English content translation. */
  translated: number;
  recheckDue: number;
  recheckUpcoming: number;
  recheckRetired: number;
};

export type AdminStats = {
  news: ArticleTypeStats & { byCategory: Record<string, number> };
  topics: ArticleTypeStats;
};

async function getTypeCounts(
  db: Database,
  itemType: 'news' | 'topic',
): Promise<Pick<ArticleTypeStats, 'total' | 'withBody' | 'translated'>> {
  const table = itemType === 'news' ? newsItems : topics;
  const [totalResult, withBodyResult, translatedResult] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(table)
      .get(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(table)
      .where(isNotNull(table.blocksJa))
      .get(),
    db
      .select({ count: sql<number>`count(DISTINCT item_id)` })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, itemType),
          eq(translations.language, 'en'),
          eq(translations.field, 'content'),
          eq(translations.state, 'done'),
        ),
      )
      .get(),
  ]);
  return {
    total: totalResult?.count ?? 0,
    withBody: withBodyResult?.count ?? 0,
    translated: translatedResult?.count ?? 0,
  };
}

/**
 * Symmetric per-type stats for the admin dashboard, plus the news category
 * breakdown. Recheck numbers come from one pass over the recheck domain.
 */
export async function getStats(db: Database): Promise<AdminStats> {
  const now = Temporal.Now.instant();
  const [newsCounts, topicCounts, entries, categoryResults] = await Promise.all(
    [
      getTypeCounts(db, 'news'),
      getTypeCounts(db, 'topic'),
      collectRecheckEntries(db, now),
      db
        .select({ category: newsItems.category, count: sql<number>`count(*)` })
        .from(newsItems)
        .groupBy(newsItems.category)
        .all(),
    ],
  );

  const recheck = {
    news: { recheckDue: 0, recheckUpcoming: 0, recheckRetired: 0 },
    topic: { recheckDue: 0, recheckUpcoming: 0, recheckRetired: 0 },
  };
  for (const entry of entries) {
    // The dashboard tracks news + topics; playguide rechecks flow through the
    // queue but aren't broken out here (no playguide tile).
    const bucket = recheck[entry.itemType as 'news' | 'topic'];
    if (!bucket) continue;
    if (entry.nextCheckAt === null) bucket.recheckRetired++;
    else if (Temporal.Instant.compare(entry.nextCheckAt, now) <= 0)
      bucket.recheckDue++;
    else bucket.recheckUpcoming++;
  }

  const byCategory: Record<string, number> = {};
  for (const row of categoryResults) {
    byCategory[row.category] = row.count;
  }

  return {
    news: { ...newsCounts, ...recheck.news, byCategory },
    topics: { ...topicCounts, ...recheck.topic },
  };
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
      blocksJa: null,
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
 * Upsert Phase-1 (list scraping) metadata for topics. Sets only title +
 * publishedAt on conflict, so it never clobbers an already-fetched block tree
 * and it corrects the placeholder date stamped by a fetch-on-view.
 * Returns the items that were newly inserted (for triggering the pipeline).
 */
export async function upsertTopicListItems(
  db: Database,
  items: Array<{ id: string; titleJa: string; publishedAt: Temporal.Instant }>,
): Promise<
  Array<{ id: string; titleJa: string; publishedAt: Temporal.Instant }>
> {
  const newlyInserted: typeof items = [];

  for (const item of items) {
    const existing = await db
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.id, item.id))
      .get();

    await db
      .insert(topics)
      .values({
        id: item.id,
        titleJa: item.titleJa,
        publishedAt: item.publishedAt,
      })
      .onConflictDoUpdate({
        target: topics.id,
        set: { titleJa: item.titleJa, publishedAt: item.publishedAt },
      });

    if (!existing) newlyInserted.push(item);
  }

  return newlyInserted;
}

/**
 * Invalidate a topic's cached block tree (re-fetched on next view / re-run).
 */
export async function invalidateTopicBody(
  db: Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .update(topics)
    .set({ blocksJa: null, bodyFetchedAt: null })
    .where(eq(topics.id, id))
    .returning({ id: topics.id });

  return result.length > 0;
}

/**
 * Upsert a topic. On conflict, updates only the columns present on `topic`
 * (title/publishedAt always; category/blocksJa/bodyFetchedAt when provided) so a
 * metadata re-upsert never clobbers an already-fetched block tree.
 */
export async function upsertTopic(
  db: Database,
  topic: NewTopic,
): Promise<void> {
  const set: Partial<NewTopic> = {
    titleJa: topic.titleJa,
    publishedAt: topic.publishedAt,
  };
  if (topic.category !== undefined) set.category = topic.category;
  if (topic.blocksJa !== undefined) set.blocksJa = topic.blocksJa;
  if (topic.bodyFetchedAt !== undefined)
    set.bodyFetchedAt = topic.bodyFetchedAt;
  if (topic.bodyCheckedAt !== undefined)
    set.bodyCheckedAt = topic.bodyCheckedAt;
  if (topic.bodyChangedAt !== undefined)
    set.bodyChangedAt = topic.bodyChangedAt;

  await db
    .insert(topics)
    .values(topic)
    .onConflictDoUpdate({ target: topics.id, set });
  if (topic.blocksJa)
    await syncArticleImages(db, 'topic', topic.id, topic.blocksJa);
}

/**
 * Replace a topic's block tree (used by the transcribe step, which mutates
 * blocks_ja in place to add image text, then saves).
 */
export async function updateTopicBlocks(
  db: Database,
  id: string,
  blocks: Block[],
): Promise<void> {
  const result = await db
    .update(topics)
    .set({ blocksJa: blocks })
    .where(eq(topics.id, id))
    .returning({ id: topics.id });
  // Sync only when a row matched, so a write against a nonexistent id can't
  // plant ghost index rows (same guard as saveChangedBody).
  if (result.length > 0) {
    await syncArticleImages(db, 'topic', id, blocks);
  }
}

/**
 * Replace a news item's block tree (used by the tag-events step via
 * saveArticleBlocks). Mirrors updateTopicBlocks so every blocks_ja writer
 * keeps the article_images index in sync.
 */
export async function updateNewsBlocks(
  db: Database,
  id: string,
  blocks: Block[],
): Promise<void> {
  const result = await db
    .update(newsItems)
    .set({ blocksJa: blocks })
    .where(eq(newsItems.id, id))
    .returning({ id: newsItems.id });
  if (result.length > 0) {
    await syncArticleImages(db, 'news', id, blocks);
  }
}

/**
 * Update the editable source fields (Japanese title and/or block tree) of a
 * news item or topic. Returns false when the item doesn't exist. Fields left
 * undefined are untouched, so a title-only edit can't clobber an unfetched
 * body.
 */
export async function updateArticleSource(
  db: Database,
  itemType: ArticleType,
  id: string,
  patch: { titleJa?: string; blocksJa?: Block[] },
): Promise<boolean> {
  const table = articleTable(itemType);
  const set: { titleJa?: string; blocksJa?: Block[] } = {};
  if (patch.titleJa !== undefined) set.titleJa = patch.titleJa;
  if (patch.blocksJa !== undefined) set.blocksJa = patch.blocksJa;
  if (Object.keys(set).length === 0) return false;

  const result = await db
    .update(table)
    .set(set)
    .where(eq(table.id, id))
    .returning({ id: table.id });
  if (result.length > 0 && patch.blocksJa) {
    await syncArticleImages(db, itemType, id, patch.blocksJa);
  }
  return result.length > 0;
}

/** A topic plus its resolved current-language title (null ⇒ show titleJa). */
export type LocalizedTopic = Topic & { titleEn: string | null };

/**
 * Get paginated list of topics (mirrors getNewsItems, including the
 * current-language title join — see getNewsItems for the join's semantics).
 */
export async function getTopics(
  db: Database,
  options: {
    category?: string;
    limit?: number;
    cursor?: string;
    language?: string;
  } = {},
): Promise<{ items: LocalizedTopic[]; hasMore: boolean; nextCursor?: string }> {
  const limit = Math.min(options.limit ?? 20, 100);
  const language = options.language ?? 'en';

  const conditions = [];
  if (options.category) {
    conditions.push(eq(topics.category, options.category));
  }
  if (options.cursor) {
    conditions.push(
      lt(topics.publishedAt, Temporal.Instant.from(options.cursor)),
    );
  }

  const results = await db
    .select({
      ...getTableColumns(topics),
      titleEn: translations.value,
    })
    .from(topics)
    .leftJoin(
      translations,
      and(
        eq(translations.itemType, 'topic'),
        eq(translations.itemId, topics.id),
        eq(translations.language, language),
        eq(translations.field, 'title'),
      ),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(topics.publishedAt))
    .limit(limit + 1)
    .all();

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
 * Lightweight paginated news list for the admin UI (mirrors listTopicsAdmin):
 * no block trees on the wire — a `hasBody` flag plus per-item translation
 * status.
 */
export async function listNewsAdmin(
  db: Database,
  options: {
    category?: string;
    limit?: number;
    cursor?: string;
    language?: string;
  } = {},
): Promise<{
  items: Array<{
    id: string;
    titleJa: string;
    /** Title in `language`, or null when not yet translated (⇒ show titleJa). */
    titleLocalized: string | null;
    category: string;
    publishedAt: Temporal.Instant;
    hasBody: boolean;
    translated: boolean;
  }>;
  hasMore: boolean;
  nextCursor?: string;
}> {
  const limit = Math.min(options.limit ?? 50, 100);
  const language = options.language ?? 'en';

  const conditions = [];
  if (options.category) {
    conditions.push(eq(newsItems.category, options.category));
  }
  if (options.cursor) {
    conditions.push(
      lt(newsItems.publishedAt, Temporal.Instant.from(options.cursor)),
    );
  }

  const rows = await db
    .select({
      id: newsItems.id,
      titleJa: newsItems.titleJa,
      titleLocalized: translations.value,
      category: newsItems.category,
      publishedAt: newsItems.publishedAt,
      hasBody: sql<number>`(${newsItems.blocksJa} IS NOT NULL)`,
    })
    .from(newsItems)
    .leftJoin(
      translations,
      and(
        eq(translations.itemType, 'news'),
        eq(translations.itemId, newsItems.id),
        eq(translations.language, language),
        eq(translations.field, 'title'),
      ),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(newsItems.publishedAt))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, -1) : rows;

  const ids = page.map((r) => r.id);
  const translatedRows = await chunked(ids, (slice) =>
    db
      .select({ itemId: translations.itemId })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'news'),
          eq(translations.language, 'en'),
          eq(translations.field, 'content'),
          eq(translations.state, 'done'),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  const translated = new Set(translatedRows.map((r) => r.itemId));

  return {
    items: page.map((r) => ({
      id: r.id,
      titleJa: r.titleJa,
      titleLocalized: r.titleLocalized,
      category: r.category,
      publishedAt: r.publishedAt,
      hasBody: !!r.hasBody,
      translated: translated.has(r.id),
    })),
    hasMore,
    nextCursor: hasMore
      ? page[page.length - 1].publishedAt.toString()
      : undefined,
  };
}

/**
 * Lightweight paginated topic list for the admin UI. Avoids pulling the full
 * block tree — derives a `hasBody` flag and joins per-item translation status.
 */
export async function listTopicsAdmin(
  db: Database,
  options: { limit?: number; cursor?: string; language?: string } = {},
): Promise<{
  items: Array<{
    id: string;
    titleJa: string;
    /** Title in `language`, or null when not yet translated (⇒ show titleJa). */
    titleLocalized: string | null;
    publishedAt: Temporal.Instant;
    hasBody: boolean;
    translated: boolean;
  }>;
  hasMore: boolean;
  nextCursor?: string;
}> {
  const limit = Math.min(options.limit ?? 50, 100);
  const language = options.language ?? 'en';

  const conditions = [];
  if (options.cursor) {
    conditions.push(
      lt(topics.publishedAt, Temporal.Instant.from(options.cursor)),
    );
  }

  const rows = await db
    .select({
      id: topics.id,
      titleJa: topics.titleJa,
      titleLocalized: translations.value,
      publishedAt: topics.publishedAt,
      hasBody: sql<number>`(${topics.blocksJa} IS NOT NULL)`,
    })
    .from(topics)
    .leftJoin(
      translations,
      and(
        eq(translations.itemType, 'topic'),
        eq(translations.itemId, topics.id),
        eq(translations.language, language),
        eq(translations.field, 'title'),
      ),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(topics.publishedAt))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, -1) : rows;

  const ids = page.map((r) => r.id);
  const translatedRows = await chunked(ids, (slice) =>
    db
      .select({ itemId: translations.itemId })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'topic'),
          eq(translations.language, 'en'),
          eq(translations.field, 'content'),
          eq(translations.state, 'done'),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  const translated = new Set(translatedRows.map((r) => r.itemId));

  return {
    items: page.map((r) => ({
      id: r.id,
      titleJa: r.titleJa,
      titleLocalized: r.titleLocalized,
      publishedAt: r.publishedAt,
      hasBody: !!r.hasBody,
      translated: translated.has(r.id),
    })),
    hasMore,
    nextCursor: hasMore
      ? page[page.length - 1].publishedAt.toString()
      : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Playguides — static reference pages under /sc/public/playguide/. Mirrors the
 * topics helpers; ordered by crawl `sortOrder` (guides have no publish date).
 * ------------------------------------------------------------------ */

/**
 * Upsert Phase-1 (crawl) metadata for playguides. Sets title + sortOrder on
 * conflict so a re-crawl corrects ordering/labels without clobbering an
 * already-fetched block tree. Returns the newly-inserted items (for eager
 * title translation).
 */
export async function upsertPlayguideListItems(
  db: Database,
  items: Array<{ id: string; titleJa: string; sortOrder: number }>,
): Promise<Array<{ id: string; titleJa: string; sortOrder: number }>> {
  const newlyInserted: typeof items = [];

  for (const item of items) {
    const existing = await db
      .select({ id: playguides.id })
      .from(playguides)
      .where(eq(playguides.id, item.id))
      .get();

    await db
      .insert(playguides)
      .values({
        id: item.id,
        titleJa: item.titleJa,
        sortOrder: item.sortOrder,
      })
      .onConflictDoUpdate({
        target: playguides.id,
        set: { titleJa: item.titleJa, sortOrder: item.sortOrder },
      });

    if (!existing) newlyInserted.push(item);
  }

  return newlyInserted;
}

/**
 * Upsert a playguide. On conflict, updates only the columns present on `pg`
 * (title/sortOrder always; blocksJa/bodyFetchedAt/state when provided) so a
 * metadata re-upsert never clobbers an already-fetched block tree.
 */
export async function upsertPlayguide(
  db: Database,
  pg: NewPlayguide,
): Promise<void> {
  const set: Partial<NewPlayguide> = { titleJa: pg.titleJa };
  if (pg.sortOrder !== undefined) set.sortOrder = pg.sortOrder;
  if (pg.blocksJa !== undefined) set.blocksJa = pg.blocksJa;
  if (pg.bodyFetchedAt !== undefined) set.bodyFetchedAt = pg.bodyFetchedAt;
  if (pg.bodyCheckedAt !== undefined) set.bodyCheckedAt = pg.bodyCheckedAt;
  if (pg.bodyChangedAt !== undefined) set.bodyChangedAt = pg.bodyChangedAt;

  await db
    .insert(playguides)
    .values(pg)
    .onConflictDoUpdate({ target: playguides.id, set });
  if (pg.blocksJa) {
    await syncArticleImages(db, 'playguide', pg.id, pg.blocksJa);
  }
}

/** Replace a playguide's block tree (used by the transcribe/tag steps). */
export async function updatePlayguideBlocks(
  db: Database,
  id: string,
  blocks: Block[],
): Promise<void> {
  const result = await db
    .update(playguides)
    .set({ blocksJa: blocks })
    .where(eq(playguides.id, id))
    .returning({ id: playguides.id });
  if (result.length > 0) {
    await syncArticleImages(db, 'playguide', id, blocks);
  }
}

/** A playguide plus its resolved current-language title (null ⇒ show titleJa). */
export type LocalizedPlayguide = Playguide & { titleEn: string | null };

/**
 * Playguide list in crawl order, each carrying its current-language title
 * (mirrors getTopics; ordered by sortOrder since guides have no date). Not
 * cursor-paginated — the guide set is small and bounded.
 */
export async function getPlayguides(
  db: Database,
  options: { language?: string; limit?: number } = {},
): Promise<LocalizedPlayguide[]> {
  const language = options.language ?? 'en';
  const query = db
    .select({
      ...getTableColumns(playguides),
      titleEn: translations.value,
    })
    .from(playguides)
    .leftJoin(
      translations,
      and(
        eq(translations.itemType, 'playguide'),
        eq(translations.itemId, playguides.id),
        eq(translations.language, language),
        eq(translations.field, 'title'),
      ),
    )
    .orderBy(asc(playguides.sortOrder), asc(playguides.id));

  return options.limit ? query.limit(options.limit).all() : query.all();
}

/**
 * Lightweight playguide list for the admin UI (mirrors listTopicsAdmin): a
 * `hasBody` flag plus per-item translation status, no block trees on the wire.
 */
export async function listPlayguidesAdmin(
  db: Database,
  options: { language?: string } = {},
): Promise<
  Array<{
    id: string;
    titleJa: string;
    /** Title in `language`, or null when not yet translated (⇒ show titleJa). */
    titleLocalized: string | null;
    sortOrder: number;
    hasBody: boolean;
    translated: boolean;
  }>
> {
  const language = options.language ?? 'en';

  const rows = await db
    .select({
      id: playguides.id,
      titleJa: playguides.titleJa,
      titleLocalized: translations.value,
      sortOrder: playguides.sortOrder,
      hasBody: sql<number>`(${playguides.blocksJa} IS NOT NULL)`,
    })
    .from(playguides)
    .leftJoin(
      translations,
      and(
        eq(translations.itemType, 'playguide'),
        eq(translations.itemId, playguides.id),
        eq(translations.language, language),
        eq(translations.field, 'title'),
      ),
    )
    .orderBy(asc(playguides.sortOrder), asc(playguides.id))
    .all();

  const ids = rows.map((r) => r.id);
  const translatedRows = await chunked(ids, (slice) =>
    db
      .select({ itemId: translations.itemId })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'playguide'),
          eq(translations.language, 'en'),
          eq(translations.field, 'content'),
          eq(translations.state, 'done'),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  const translated = new Set(translatedRows.map((r) => r.itemId));

  return rows.map((r) => ({
    id: r.id,
    titleJa: r.titleJa,
    titleLocalized: r.titleLocalized,
    sortOrder: r.sortOrder,
    hasBody: !!r.hasBody,
    translated: translated.has(r.id),
  }));
}

/**
 * One page of article ids of a single `itemType` whose Japanese `title_ja` OR
 * `blocks_ja` contains `sourceText`, ordered by id so `afterId` (the last id of
 * the previous page) gives stable keyset pagination through the *entire*
 * affected set. Backs the glossary regenerate workflow, which pages every match
 * one durable step at a time — no global cap, so no affected article is ever
 * silently skipped.
 *
 * Both fields are searched because the ArticleWorkflow's translate step resolves
 * the glossary from `title_ja` + the serialized body and re-writes *both* the
 * title and content translations (see steps/translate.ts). A term that appears
 * only in an article's title still changes its translation, so title-only
 * matches must be re-triggered too — including not-yet-fetched articles
 * (`blocks_ja IS NULL`), whose stale title translation the re-run also fixes.
 *
 * Matches with `instr` (like {@link findMatchingGlossaryEntries}, so no LIKE
 * escaping). Triggering a match doesn't remove it from the result set, so
 * pagination must key on `id` (not "rows drop out") to terminate.
 */
export async function findArticlesContainingSourcePage(
  db: Database,
  sourceText: string,
  itemType: ArticleType,
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  // Branch per type rather than a union column so the drizzle types stay precise.
  if (itemType === 'news') {
    const rows = await db
      .select({ id: newsItems.id })
      .from(newsItems)
      .where(
        and(
          or(
            sql`instr(${newsItems.titleJa}, ${sourceText}) > 0`,
            sql`instr(${newsItems.blocksJa}, ${sourceText}) > 0`,
          ),
          afterId != null ? gt(newsItems.id, afterId) : undefined,
        ),
      )
      .orderBy(asc(newsItems.id))
      .limit(limit)
      .all();
    return rows.map((r) => r.id);
  }

  if (itemType === 'topic') {
    const rows = await db
      .select({ id: topics.id })
      .from(topics)
      .where(
        and(
          or(
            sql`instr(${topics.titleJa}, ${sourceText}) > 0`,
            sql`instr(${topics.blocksJa}, ${sourceText}) > 0`,
          ),
          afterId != null ? gt(topics.id, afterId) : undefined,
        ),
      )
      .orderBy(asc(topics.id))
      .limit(limit)
      .all();
    return rows.map((r) => r.id);
  }

  const rows = await db
    .select({ id: playguides.id })
    .from(playguides)
    .where(
      and(
        or(
          sql`instr(${playguides.titleJa}, ${sourceText}) > 0`,
          sql`instr(${playguides.blocksJa}, ${sourceText}) > 0`,
        ),
        afterId != null ? gt(playguides.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(playguides.id))
    .limit(limit)
    .all();
  return rows.map((r) => r.id);
}

/**
 * One page of stored images whose transcribed Japanese (`texts_ja`) contains
 * `sourceText`, keyset-paginated by `id` so `afterId` (the last id of the
 * previous page) walks the *entire* affected set. Backs the image half of the
 * glossary regenerate workflow, which refreshes each match's stored `text`
 * translation so it picks up an edited override.
 *
 * `texts_ja` is a serialized JSON string array, so `instr` matches the term
 * inside it — the same untyped substring match {@link findArticlesContainingSourcePage}
 * uses on `blocks_ja` (no LIKE escaping). NULL (not-yet-transcribed) and `[]`
 * (transcribed, no text) rows can't contain the term and so drop out naturally.
 * Only `id` + `textsJa` are returned — everything the re-translation needs, and
 * nothing (like the Temporal `updatedAt`) that would complicate crossing a
 * durable step boundary.
 */
export async function findImagesContainingSourcePage(
  db: Database,
  sourceText: string,
  afterId: number | null,
  limit: number,
): Promise<Array<{ id: number; textsJa: string[] | null }>> {
  return db
    .select({ id: images.id, textsJa: images.textsJa })
    .from(images)
    .where(
      and(
        sql`instr(${images.textsJa}, ${sourceText}) > 0`,
        afterId != null ? gt(images.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(images.id))
    .limit(limit)
    .all();
}

/** Invalidate a playguide's cached block tree (re-fetched on next view / re-run). */
export async function invalidatePlayguideBody(
  db: Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .update(playguides)
    .set({ blocksJa: null, bodyFetchedAt: null })
    .where(eq(playguides.id, id))
    .returning({ id: playguides.id });
  return result.length > 0;
}

/**
 * Get the localized title + block tree for an article (news item or topic), if
 * translated. The `content` translation stores the block tree as a JSON blob.
 * `translatedAt` is the content row's timestamp (falling back to the title's).
 */
export async function getArticleTranslations(
  db: Database,
  itemType: ArticleType,
  id: string,
  language: string = 'en',
): Promise<{
  title: string | null;
  blocks: Block[] | null;
  translatedAt: Temporal.Instant | null;
}> {
  const rows = await db
    .select()
    .from(translations)
    .where(
      and(
        eq(translations.itemType, itemType),
        eq(translations.itemId, id),
        eq(translations.language, language),
      ),
    )
    .all();

  // Stale-while-revalidate: a running re-translation keeps its previous value,
  // which is still the best thing to render. Only value-less rows are skipped.
  let title: string | null = null;
  let blocks: Block[] | null = null;
  let titleAt: Temporal.Instant | null = null;
  let contentAt: Temporal.Instant | null = null;
  for (const row of rows) {
    if (row.value === null) continue;
    if (row.field === 'title') {
      title = row.value;
      titleAt = row.translatedAt;
    } else if (row.field === 'content') {
      try {
        blocks = JSON.parse(row.value) as Block[];
        contentAt = row.translatedAt;
      } catch {
        blocks = null;
      }
    }
  }
  return { title, blocks, translatedAt: contentAt ?? titleAt };
}

/** An extracted event with its English title translation merged in (null when
 * the title hasn't been translated yet — the caller falls back to titleJa). */
export type EventWithTitle = Event & { titleEn: string | null };

/**
 * Fetch the events extracted from a single source article (news item or topic),
 * ordered chronologically by start time, each merged with its English title
 * translation (item_type='event') when one exists. Powers the "events in this
 * article" rail on the article pages.
 */
export async function getEventsForSource(
  db: Database,
  sourceType: 'news' | 'topic',
  sourceId: string,
  language: string = 'en',
): Promise<EventWithTitle[]> {
  // Via the provenance join, not events.source_id: a campaign mentioned here
  // but whose *primary* source is a different article (its own dedicated page)
  // must still appear in this article's rail.
  const rows = await db
    .select(getTableColumns(events))
    .from(events)
    .innerJoin(eventSources, eq(eventSources.eventId, events.id))
    .where(
      and(
        eq(eventSources.sourceType, sourceType),
        eq(eventSources.sourceId, sourceId),
      ),
    )
    .orderBy(asc(events.startTime))
    .all();
  return mergeEventTitles(db, rows, language);
}

/**
 * Fetch every event overlapping a single JST calendar day, ordered by start
 * time, each merged with its title translation. Powers the day-scoped agenda
 * timeline page. An event overlaps the day `[dayStart, dayEnd)` when it starts
 * before the day ends and its effective end (its own end, or its start for the
 * end-less allDay/mark rows) lands on or after the day starts.
 *
 * Bounds are compared as the stored RFC9557 strings: all rows share the
 * `[Asia/Tokyo]` zone and a fixed format, so lexicographic order matches
 * chronological order.
 */
export async function getEventsForDay(
  db: Database,
  jstDate: Temporal.PlainDate,
  language: string = 'en',
): Promise<EventWithTitle[]> {
  const dayStart = jstDate.toZonedDateTime('Asia/Tokyo');
  const dayEnd = dayStart.add({ days: 1 });
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        lt(events.startTime, dayEnd),
        or(
          // Starts within the day (covers point-in-time events at 00:00)…
          gte(events.startTime, dayStart),
          // …or began earlier and runs strictly past 00:00. An event ending
          // exactly at 00:00 belongs to the previous day, so it no longer shows
          // as a zero-height sliver pinned to the top of this one.
          gt(events.endTime, dayStart),
        ),
      ),
    )
    .orderBy(asc(events.startTime))
    .all();
  return mergeEventTitles(db, rows, language);
}

/**
 * Merge each event row with its title translation for `language`. Shared by the
 * per-source and per-day fetches. Stale-while-revalidate: keep a running
 * re-translation's prior value; skip only value-less rows (mirrors
 * getArticleTranslations).
 */
async function mergeEventTitles(
  db: Database,
  rows: Event[],
  language: string,
): Promise<EventWithTitle[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const trans = await chunked(ids, (slice) =>
    db
      .select()
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'event'),
          eq(translations.language, language),
          eq(translations.field, 'title'),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  const byId = new Map(
    trans.filter((t) => t.value !== null).map((t) => [t.itemId, t.value]),
  );
  return rows.map((r) => ({ ...r, titleEn: byId.get(r.id) ?? null }));
}

/**
 * Replace the scraped schedule events (sourceType='schedule') that the fresh
 * つよさ予報 scrape re-covers. The page only ever shows the near-future window,
 * so deletion is scoped per content key to that content's earliest new row
 * onward — rows that have scrolled off the page are kept as history.
 * Delete-then-insert (batched to stay under D1's bound-parameter cap); ids are
 * deterministic so a partial failure self-heals on the next run.
 */
export async function replaceScheduleEvents(
  db: Database,
  rows: NewEvent[],
): Promise<void> {
  // Each content's coverage window starts at its earliest scraped row. Content
  // key is the sourceId up to the '#' ("defense#https://…/12.png" → "defense").
  const windowStarts = new Map<string, Temporal.ZonedDateTime>();
  for (const row of rows) {
    if (!row.sourceId) continue;
    const content = row.sourceId.split('#')[0];
    const prev = windowStarts.get(content);
    if (!prev || Temporal.ZonedDateTime.compare(row.startTime, prev) < 0) {
      windowStarts.set(content, row.startTime);
    }
  }
  for (const [content, start] of windowStarts) {
    await db
      .delete(events)
      .where(
        and(
          eq(events.sourceType, 'schedule'),
          or(
            eq(events.sourceId, content),
            like(events.sourceId, `${content}#%`),
          ),
          gte(events.startTime, start),
        ),
      );
  }
  // 8 bound params per row; D1 caps a statement at 100, so 12 rows max.
  const ROWS_PER_INSERT = 12;
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const batch = rows.slice(i, i + ROWS_PER_INSERT);
    if (batch.length === 0) continue;
    await db.insert(events).values(batch).onConflictDoNothing();
  }
}

/**
 * Prune scraped schedule events (sourceType='schedule') whose occurrence ended
 * before `cutoff`, along with their title translations. Schedule rows accrete
 * daily forever (each occurrence is its own row), so a retention horizon keeps
 * the table bounded; article events are never pruned. Returns the number of
 * events deleted.
 */
export async function pruneScheduleEvents(
  db: Database,
  cutoff: Temporal.ZonedDateTime,
): Promise<number> {
  const stale = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.sourceType, 'schedule'),
        lt(
          sql`COALESCE(${events.endTime}, ${events.startTime})`,
          // Serialize with the column's own driver mapping (offset: 'never').
          cutoff.toString({ offset: 'never' }),
        ),
      ),
    )
    .all();
  if (stale.length === 0) return 0;

  const ids = stale.map((r) => r.id);
  await chunked(ids, async (slice) => {
    await db.delete(events).where(inArray(events.id, slice));
    await db
      .delete(translations)
      .where(
        and(
          eq(translations.itemType, 'event'),
          inArray(translations.itemId, slice),
        ),
      );
    return [];
  });
  return ids.length;
}

// ── Reset milestones ────────────────────────────────────────────────────────
// Admin-managed recurring resets. The definitions live in `reset_milestones`;
// `refreshResetEvents` (workflow cron) materializes the next horizon of their
// occurrences into `events` as `mark` rows via `buildResetEvents`, then swaps
// them in with `replaceResetEvents`. See reset-events.ts.

/** Create or update a reset definition (admin editor). */
export async function upsertResetMilestone(
  db: Database,
  row: NewResetMilestone,
): Promise<void> {
  await db
    .insert(resetMilestones)
    .values(row)
    .onConflictDoUpdate({
      target: resetMilestones.id,
      set: {
        titleJa: row.titleJa,
        titles: row.titles,
        rrule: row.rrule,
        enabled: row.enabled,
        sortOrder: row.sortOrder,
        note: row.note,
        updatedAt: row.updatedAt,
      },
    });
}

/** Delete a reset definition. Its materialized events clear on the next refresh
 *  (or immediately, when the admin API re-materializes after the change). */
export async function deleteResetMilestone(
  db: Database,
  id: string,
): Promise<void> {
  await db.delete(resetMilestones).where(eq(resetMilestones.id, id));
}

/**
 * Swap in a freshly materialized set of reset `mark` events (sourceType='reset')
 * for the forward window starting at `from`: delete the existing reset rows from
 * `from` onward (clearing anything a disabled/edited def no longer covers) with
 * their title translations, then insert the new rows and per-language titles.
 * Batched to stay under D1's ~100 bound-parameter cap; deterministic ids let a
 * partial failure self-heal on the next run.
 */
export async function replaceResetEvents(
  db: Database,
  rows: NewEvent[],
  titles: ResetTitleMap,
  from: Temporal.ZonedDateTime,
  now: Temporal.Instant,
): Promise<void> {
  // Clear the window we're about to rewrite (drizzle serializes the bound
  // ZonedDateTime with the column's own offset:'never' mapping).
  const stale = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.sourceType, RESET_SOURCE_TYPE),
        gte(events.startTime, from),
      ),
    )
    .all();
  const staleIds = stale.map((r) => r.id);
  await chunked(staleIds, async (slice) => {
    await db.delete(events).where(inArray(events.id, slice));
    await db
      .delete(translations)
      .where(
        and(
          eq(translations.itemType, 'event'),
          inArray(translations.itemId, slice),
        ),
      );
    return [];
  });

  // 8 bound params per event; D1 caps a statement at 100, so 12 rows max.
  const EVENTS_PER_INSERT = 12;
  for (let i = 0; i < rows.length; i += EVENTS_PER_INSERT) {
    const batch = rows.slice(i, i + EVENTS_PER_INSERT);
    if (batch.length > 0) {
      await db.insert(events).values(batch).onConflictDoNothing();
    }
  }

  // Flatten the per-language titles into translation rows (state='done', so the
  // CHECK requires value + translatedAt + model — these are admin-authored, not
  // AI output, so the model marker is the source tag).
  const titleRows: (typeof translations.$inferInsert)[] = [];
  for (const row of rows) {
    const perLang = titles.get(row.id);
    if (!perLang) continue;
    for (const [language, value] of Object.entries(perLang)) {
      titleRows.push({
        itemType: 'event',
        itemId: row.id,
        language,
        field: 'title',
        state: 'done',
        value,
        translatedAt: now,
        model: RESET_SOURCE_TYPE,
        updatedAt: now,
      });
    }
  }
  // 9 bound params per translation row → 10 rows max under the cap.
  const TITLES_PER_INSERT = 10;
  for (let i = 0; i < titleRows.length; i += TITLES_PER_INSERT) {
    const batch = titleRows.slice(i, i + TITLES_PER_INSERT);
    if (batch.length > 0) {
      await db.insert(translations).values(batch).onConflictDoNothing();
    }
  }
}

/**
 * Prune materialized reset events (sourceType='reset') that have already passed,
 * with their title translations. Reset rows accrete forever (one mark per day),
 * so a retention horizon keeps the table bounded. Returns the number deleted.
 */
export async function pruneResetEvents(
  db: Database,
  cutoff: Temporal.ZonedDateTime,
): Promise<number> {
  const stale = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.sourceType, RESET_SOURCE_TYPE),
        lt(events.startTime, cutoff),
      ),
    )
    .all();
  if (stale.length === 0) return 0;

  const ids = stale.map((r) => r.id);
  await chunked(ids, async (slice) => {
    await db.delete(events).where(inArray(events.id, slice));
    await db
      .delete(translations)
      .where(
        and(
          eq(translations.itemType, 'event'),
          inArray(translations.itemId, slice),
        ),
      );
    return [];
  });
  return ids.length;
}

/** Default forward window materialized by {@link materializeResetEvents}. */
export const RESET_HORIZON_DAYS = 120;

/**
 * Materialize the enabled reset definitions into `events` for a forward window
 * and swap them in. The window starts at midnight JST *today* (so a reset that
 * already fired earlier today still shows on today's calendar) and runs
 * `horizonDays` ahead. Shared by the nightly cron and the admin editor (which
 * re-materializes on save so edits appear without waiting for the cron).
 * Returns how many merged marks were written.
 */
export async function materializeResetEvents(
  db: Database,
  opts: { now?: Temporal.Instant; horizonDays?: number } = {},
): Promise<{ marks: number }> {
  const now = opts.now ?? Temporal.Now.instant();
  const horizonDays = opts.horizonDays ?? RESET_HORIZON_DAYS;

  const from = now
    .toZonedDateTimeISO('Asia/Tokyo')
    .toPlainDate()
    .toZonedDateTime('Asia/Tokyo');
  const to = from.add({ days: horizonDays });

  const [defs, languages] = await Promise.all([
    db.query.resetMilestones.findMany({
      orderBy: { sortOrder: 'asc', id: 'asc' },
    }),
    getEnabledLanguages(db),
  ]);
  const { events: rows, titles } = buildResetEvents(
    defs,
    from,
    to,
    languages.map((l) => l.code),
    now,
  );
  await replaceResetEvents(db, rows, titles, from, now);
  return { marks: rows.length };
}

/**
 * The subset of `itemIds` that already has a `done` translation for
 * (itemType, language, field). Used to skip work — e.g. the "lesser" schedule
 * title translator only fills gaps and must never re-translate/overwrite.
 */
export async function getTranslatedItemIds(
  db: Database,
  itemType: ItemType,
  itemIds: string[],
  language: string,
  field: TranslationField = 'title',
): Promise<Set<string>> {
  const rows = await chunked(itemIds, (slice) =>
    db
      .select({ itemId: translations.itemId })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, itemType),
          eq(translations.language, language),
          eq(translations.field, field),
          eq(translations.state, 'done'),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  return new Set(rows.map((r) => r.itemId));
}

/**
 * Upsert a finished article/event translation row (item_type='news'|'topic'|
 * 'event'), landing state='done' with the value and model attribution. The
 * generic counterpart to upsertTopicTranslation — used by the eager title step
 * (DQX-11) so it can write news and topic titles through one helper.
 */
export async function upsertItemTranslation(
  db: Database,
  params: {
    itemType: Exclude<ItemType, 'image'>;
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
      itemType: params.itemType,
      itemId: params.itemId,
      language: params.language,
      field: params.field,
      state: 'done',
      value: params.value,
      translatedAt: now,
      model: params.model,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        translations.itemType,
        translations.itemId,
        translations.language,
        translations.field,
      ],
      set: {
        state: 'done',
        error: null,
        value: params.value,
        translatedAt: now,
        model: params.model,
        updatedAt: now,
      },
    });
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
      state: 'done',
      value: params.value,
      translatedAt: now,
      model: params.model,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        translations.itemType,
        translations.itemId,
        translations.language,
        translations.field,
      ],
      set: {
        state: 'done',
        error: null,
        value: params.value,
        translatedAt: now,
        model: params.model,
        updatedAt: now,
      },
    });
}

/* ------------------------------------------------------------------ *
 * Pipeline state transitions
 * ------------------------------------------------------------------ */

/**
 * Set the state on translation rows without touching their value — creating
 * the rows if this is the first time a step touches them. A re-run therefore
 * keeps the previous value visible while state says `running`
 * (stale-while-revalidate).
 */
export async function setTranslationStates(
  db: Database,
  params: {
    itemType: ItemType;
    itemId: string;
    language: string;
    fields: TranslationField[];
    state: Exclude<PhaseState, 'done'>; // 'done' only lands with a value, via the upsert helpers
    error?: string;
  },
): Promise<void> {
  const now = Temporal.Now.instant();
  const error = params.state === 'failed' ? (params.error ?? null) : null;
  for (const field of params.fields) {
    await db
      .insert(translations)
      .values({
        itemType: params.itemType,
        itemId: params.itemId,
        language: params.language,
        field,
        state: params.state,
        error,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          translations.itemType,
          translations.itemId,
          translations.language,
          translations.field,
        ],
        set: { state: params.state, error, updatedAt: now },
      });
  }
}

/**
 * Read the state of translation rows for an item. Missing rows are `pending`
 * — the pipeline hasn't picked them up yet.
 */
export async function getTranslationStates(
  db: Database,
  itemType: ItemType,
  itemId: string,
  language: string,
  fields: TranslationField[],
): Promise<Map<TranslationField, PhaseState>> {
  const rows = await db
    .select({ field: translations.field, state: translations.state })
    .from(translations)
    .where(
      and(
        eq(translations.itemType, itemType),
        eq(translations.itemId, itemId),
        eq(translations.language, language),
        inArray(translations.field, fields),
      ),
    )
    .all();
  const byField = new Map(rows.map((r) => [r.field, r.state]));
  return new Map(
    fields.map((f) => [f, (byField.get(f) ?? 'pending') as PhaseState]),
  );
}

/**
 * Reset any title-translation rows still `running` back to `pending` for a set
 * of items — the title workflow's terminal-failure cleanup, so a chunk that
 * exhausted its retries doesn't leave titles stuck `running`. Deliberately NOT
 * scoped to a language: the failed run's language set is a step return the
 * cleanup can't see, and a whitelist re-read would miss a language disabled
 * mid-run — id-scoped-across-all-languages clears everything the run could
 * have claimed. Only touches `running` rows, so it never clobbers a sibling
 * chunk's `done`.
 */
export async function resetRunningTitles(
  db: Database,
  itemType: ArticleType,
  itemIds: string[],
): Promise<void> {
  if (itemIds.length === 0) return;
  const now = Temporal.Now.instant();
  for (let i = 0; i < itemIds.length; i += IN_CHUNK) {
    await db
      .update(translations)
      .set({ state: 'pending', updatedAt: now })
      .where(
        and(
          eq(translations.itemType, itemType),
          eq(translations.field, 'title'),
          eq(translations.state, 'running'),
          inArray(translations.itemId, itemIds.slice(i, i + IN_CHUNK)),
        ),
      );
  }
}

/**
 * Reset every title-translation row still `running` back to `pending` for one
 * language, across both item types — the backfill workflow's terminal-failure
 * cleanup. Unlike resetRunningTitles it isn't scoped to an id set (the backfill
 * pages the archive rather than carrying ids), so it clears anything a dying
 * run left claimed. Only `running` rows are touched, so a `done` title keeps
 * its value; a title with no value renders its JA fallback either way.
 */
export async function resetRunningTitlesForLanguage(
  db: Database,
  language: string,
): Promise<void> {
  await db
    .update(translations)
    .set({ state: 'pending', updatedAt: Temporal.Now.instant() })
    .where(
      and(
        inArray(translations.itemType, ['news', 'topic', 'playguide']),
        eq(translations.language, language),
        eq(translations.field, 'title'),
        eq(translations.state, 'running'),
      ),
    );
}

/**
 * Terminal cleanup when a workflow dies: this item's translation rows still
 * marked in-flight become `failed`, so the admin panels and later re-runs see
 * a settled state instead of an eternal `running`. Scoped to the item's own
 * rows — shared image rows are owned by whichever workflow is actually
 * touching them.
 */
export async function failPipelineStates(
  db: Database,
  itemType: ArticleType,
  itemId: string,
  language: string,
  error: string,
): Promise<void> {
  const now = Temporal.Now.instant();
  await db
    .update(translations)
    .set({ state: 'failed', error, updatedAt: now })
    .where(
      and(
        eq(translations.itemType, itemType),
        eq(translations.itemId, itemId),
        eq(translations.language, language),
        inArray(translations.state, ['pending', 'running']),
      ),
    );
}

/**
 * Ensure an image row exists for every key, so the pipeline has rows to hang
 * transcription state on. Existing rows (any state) are left untouched.
 */
export async function ensureImageRows(
  db: Database,
  keys: string[],
): Promise<void> {
  const now = Temporal.Now.instant();
  // Batched inserts: each row binds several parameters, so keep batches small
  // enough to stay under D1's per-statement cap.
  const ROWS_PER_INSERT = 20;
  for (let i = 0; i < keys.length; i += ROWS_PER_INSERT) {
    await db
      .insert(images)
      .values(
        keys
          .slice(i, i + ROWS_PER_INSERT)
          .map((key) => ({ key, updatedAt: now })),
      )
      .onConflictDoNothing();
  }
}

/** Set the transcription state on an image row (running/failed transitions). */
export async function setImageTranscribeState(
  db: Database,
  key: string,
  state: Exclude<PhaseState, 'done'>, // 'done' lands with texts via upsertImageTranscription
): Promise<void> {
  await db
    .update(images)
    .set({ transcribeState: state, updatedAt: Temporal.Now.instant() })
    .where(eq(images.key, key));
}

/** Set the mirror (CDN → R2 copy) state on an image row. */
export async function setImageMirrorState(
  db: Database,
  key: string,
  state: PhaseState,
): Promise<void> {
  await db
    .update(images)
    .set({ mirrorState: state, updatedAt: Temporal.Now.instant() })
    .where(eq(images.key, key));
}

/* ------------------------------------------------------------------ *
 * Images (per-distinct-image transcription + localization state)
 * ------------------------------------------------------------------ */

/**
 * Record an image's transcription (get-or-create by key). `textsJa` is every
 * transcribed span ([] if none). Returns the surrogate image id (used as
 * translations.item_id). Whether it's worth localizing is derived from textsJa.
 */
export async function upsertImageTranscription(
  db: Database,
  params: { key: string; textsJa: string[]; model: string },
): Promise<number> {
  const now = Temporal.Now.instant();
  const rows = await db
    .insert(images)
    .values({
      key: params.key,
      textsJa: params.textsJa,
      transcribeModel: params.model,
      transcribeState: 'done',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: images.key,
      set: {
        textsJa: params.textsJa,
        transcribeModel: params.model,
        transcribeState: 'done',
        updatedAt: now,
      },
    })
    .returning({ id: images.id });
  return rows[0].id;
}

/** One row of an image's restructured Japanese spans. `from` is the index the
 *  row occupied in the CURRENT texts_ja, or null for a newly added row. */
export type ImageSpanEdit = { text: string; from: number | null };

/**
 * Rewrite an image's Japanese spans — the admin edit screen's add/remove/edit
 * of the JA→target rows, which the transcriber otherwise owns.
 *
 * Every language's translated `text` row is index-aligned to `texts_ja`, so the
 * spans can't move on their own: dropping a span anywhere but the tail would
 * shift every later translation onto the wrong source text, in every language
 * at once. Callers therefore say where each surviving row CAME FROM, and this
 * replays that mapping across all of them — the same edit, applied everywhere,
 * in one atomic batch.
 *
 * A row without a `from` starts blank in every language: there is no translated
 * text for source text that didn't exist until now.
 */
export async function restructureImageTexts(
  db: Database,
  imageId: number,
  spans: ImageSpanEdit[],
): Promise<void> {
  const now = Temporal.Now.instant();

  const rows = await db
    .select()
    .from(translations)
    .where(
      and(
        eq(translations.itemType, 'image'),
        eq(translations.itemId, String(imageId)),
        eq(translations.field, 'text'),
      ),
    )
    .all();

  const statements: BatchItem<'sqlite'>[] = [
    db
      .update(images)
      .set({ textsJa: spans.map((s) => s.text), updatedAt: now })
      .where(eq(images.id, imageId)),
  ];

  for (const row of rows) {
    let previous: string[] = [];
    try {
      const parsed = JSON.parse(row.value ?? '[]');
      if (Array.isArray(parsed)) previous = parsed as string[];
    } catch {
      // A malformed value realigns to blanks rather than failing the edit.
    }
    const next = spans.map((s) =>
      s.from === null ? '' : (previous[s.from] ?? ''),
    );
    statements.push(
      db
        .update(translations)
        .set({ value: JSON.stringify(next), updatedAt: now })
        .where(
          and(
            eq(translations.itemType, 'image'),
            eq(translations.itemId, String(imageId)),
            eq(translations.language, row.language),
            eq(translations.field, 'text'),
          ),
        ),
    );
  }

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

/**
 * Replace an article's rows in the article_images reverse index from its block
 * tree. Called by every blocks_ja writer so the index can't drift. Only
 * block-level images are indexed (the localizable ones — see the schema doc);
 * delete-then-insert as one atomic D1 batch, so a failure partway can't leave
 * the index emptied or half-written while blocks_ja still references the keys.
 *
 * The invalidate helpers (blocksJa → null pending refetch) deliberately do NOT
 * clear the index: the article still conceptually embeds those images, so a
 * purge in the window before the refetch over-includes a blockless page
 * (harmless) rather than under-purging if the refetch never lands. The next
 * real block write replaces the set.
 */
export async function syncArticleImages(
  db: Database,
  itemType: ArticleType,
  itemId: string,
  blocks: Block[],
): Promise<void> {
  const keys = [
    ...new Set(
      collectImages(blocks)
        .map((i) => imageKey(i.src))
        .filter((k): k is string => !!k),
    ),
  ];
  const del = db
    .delete(articleImages)
    .where(
      and(
        eq(articleImages.itemType, itemType),
        eq(articleImages.itemId, itemId),
      ),
    );
  // Inserts sliced to respect D1's per-query bind-parameter cap.
  const inserts = [];
  for (let i = 0; i < keys.length; i += 30) {
    inserts.push(
      db.insert(articleImages).values(
        keys.slice(i, i + 30).map((key) => ({
          itemType,
          itemId,
          imageKey: key,
        })),
      ),
    );
  }
  await db.batch([del, ...inserts]);
}

/**
 * Backfill one page of the article_images index for one item type — for
 * articles written before the index existed (new writes keep it current via
 * syncArticleImages). Cursor-paginated by id; idempotent, so re-running over
 * already-indexed articles is harmless.
 */
export async function backfillArticleImages(
  db: Database,
  itemType: ArticleType,
  cursor: string | null,
  limit = 100,
): Promise<{ processed: number; nextCursor: string | null }> {
  const table = articleTable(itemType);
  const rows = await db
    .select({ id: table.id, blocksJa: table.blocksJa })
    .from(table)
    .where(cursor ? gt(table.id, cursor) : undefined)
    .orderBy(asc(table.id))
    .limit(limit)
    .all();
  for (const row of rows) {
    if (row.blocksJa) {
      await syncArticleImages(db, itemType, row.id, row.blocksJa);
    }
  }
  return {
    processed: rows.length,
    nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
  };
}

/** Look up image rows by their natural keys (imageKey). */
export async function getImagesByKeys(
  db: Database,
  keys: string[],
): Promise<Image[]> {
  return chunked(keys, (slice) =>
    db.select().from(images).where(inArray(images.key, slice)).all(),
  );
}

/** The subset of `imageIds` that already have a translated `text` row for `language`. */
export async function getTranslatedImageIds(
  db: Database,
  imageIds: number[],
  language: string,
): Promise<Set<number>> {
  const rows = await chunked(imageIds.map(String), (slice) =>
    db
      .select({ itemId: translations.itemId })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'image'),
          eq(translations.language, language),
          eq(translations.field, 'text'),
          eq(translations.state, 'done'),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  return new Set(rows.map((r) => Number(r.itemId)));
}

/**
 * Map image id → pipeline state of its translation row for a `field` and
 * language. Ids without a row are absent (i.e. derived-pending).
 */
export async function getImageTranslationStates(
  db: Database,
  imageIds: number[],
  language: string,
  field: 'text' | 'url',
): Promise<Map<number, PhaseState>> {
  const rows = await chunked(imageIds.map(String), (slice) =>
    db
      .select({ itemId: translations.itemId, state: translations.state })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'image'),
          eq(translations.language, language),
          eq(translations.field, field),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  return new Map(rows.map((r) => [Number(r.itemId), r.state]));
}

/** Map image id → translation value for a given `field` ('text' | 'url') and language. */
export async function getImageTranslations(
  db: Database,
  imageIds: number[],
  language: string,
  field: 'text' | 'url',
): Promise<Map<number, string>> {
  const rows = await chunked(imageIds.map(String), (slice) =>
    db
      .select({ itemId: translations.itemId, value: translations.value })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'image'),
          eq(translations.language, language),
          eq(translations.field, field),
          isNotNull(translations.value),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  return new Map(rows.map((r) => [Number(r.itemId), r.value!]));
}

/**
 * Map image id → the model that produced its localized image (the `url` row's
 * model), for a language. Lets the localize step regenerate only when the model
 * changed (or is missing).
 */
export async function getLocalizedImageModels(
  db: Database,
  imageIds: number[],
  language: string,
): Promise<Map<number, string>> {
  const rows = await chunked(imageIds.map(String), (slice) =>
    db
      .select({ itemId: translations.itemId, model: translations.model })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'image'),
          eq(translations.language, language),
          eq(translations.field, 'url'),
          eq(translations.state, 'done'),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  return new Map(rows.map((r) => [Number(r.itemId), r.model!]));
}

/**
 * One stored image plus its per-language translation rows — the shape behind
 * the admin Images screen. `text` is the translated spans row, `url` the
 * localized-image row (its `value` is the R2 key). Either is null when that
 * step hasn't created a row yet for the language.
 */
export type AdminImageRow = {
  image: Image;
  text: Translation | null;
  url: Translation | null;
  /** True when this image backs a rotation banner (banners.imageKey = key). */
  isBanner: boolean;
};

/** Image source categories the admin screen can filter to (banner is the only
 * one with a first-class join today; topic/playguide live in block trees). */
export type ImageSourceFilter = 'banner';

/**
 * A GLOB that matches any hiragana/katakana/kanji character — the SQL twin of
 * `hasJapanese` (see @hiroba/shared). Because a `texts_ja` value is a JSON array
 * whose structural characters (`[] "",`) are all ASCII, matching Japanese
 * anywhere in the raw text is exactly "some span contains Japanese".
 */
const JAPANESE_GLOB = '*[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]*';

/**
 * List stored images newest-first (by surrogate id), each paired with its
 * `text`/`url` translation rows for one language. Cursor-paginated on the id so
 * the admin can lazily page the whole corpus.
 *
 * `onlyText` and `source` filter server-side (in the WHERE clause), so paging
 * and the has-more/next-cursor accounting are computed over the filtered set —
 * "Load more" walks the matches, not every image.
 */
export async function listImagesForAdmin(
  db: Database,
  opts: {
    language: string;
    limit?: number;
    cursor?: number;
    /** Keep only images bearing Japanese text (localization candidates). */
    onlyText?: boolean;
    /** Keep only images from this source (currently: rotation banners). */
    source?: ImageSourceFilter;
  },
): Promise<{ rows: AdminImageRow[]; hasMore: boolean; nextCursor?: number }> {
  const limit = Math.min(opts.limit ?? 30, 100);
  // Every page is the same `id < cursor` shape; the first page uses a sentinel
  // above every id (ids are autoincrement, so MAX_SAFE_INTEGER matches all).
  const cursor = opts.cursor ?? Number.MAX_SAFE_INTEGER;

  const conditions = [lt(images.id, cursor)];
  if (opts.onlyText) {
    // Transcribed (non-null) and carrying at least one Japanese character.
    conditions.push(isNotNull(images.textsJa));
    conditions.push(sql`${images.textsJa} GLOB ${JAPANESE_GLOB}`);
  }
  if (opts.source === 'banner') {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(banners)
          .where(eq(banners.imageKey, images.key)),
      ),
    );
  }

  const imgRows = await db
    .select()
    .from(images)
    .where(and(...conditions))
    .orderBy(desc(images.id))
    .limit(limit + 1)
    .all();

  const hasMore = imgRows.length > limit;
  const page = hasMore ? imgRows.slice(0, limit) : imgRows;

  // Pull this language's text + url rows for the whole page in one fan-out.
  const ids = page.map((r) => String(r.id));
  const trRows = ids.length
    ? await chunked(ids, (slice) =>
        db
          .select()
          .from(translations)
          .where(
            and(
              eq(translations.itemType, 'image'),
              eq(translations.language, opts.language),
              inArray(translations.field, ['text', 'url']),
              inArray(translations.itemId, slice),
            ),
          )
          .all(),
      )
    : [];

  const textById = new Map<number, Translation>();
  const urlById = new Map<number, Translation>();
  for (const tr of trRows) {
    (tr.field === 'url' ? urlById : textById).set(Number(tr.itemId), tr);
  }

  // Which of this page's images back a rotation banner (banners.imageKey = key).
  // Banners are the one image source with a first-class join, so we can tag them
  // cheaply here; topic/playguide membership lives only inside block trees. When
  // the page is already filtered to banners, every row is one — skip the query.
  const keys = page.map((r) => r.key);
  const bannerKeys =
    opts.source === 'banner' || keys.length === 0
      ? new Set(keys)
      : new Set(
          (
            await chunked(keys, (slice) =>
              db
                .select({ imageKey: banners.imageKey })
                .from(banners)
                .where(inArray(banners.imageKey, slice))
                .all(),
            )
          ).map((r) => r.imageKey),
        );

  const rows = page.map((image) => ({
    image,
    text: textById.get(image.id) ?? null,
    url: urlById.get(image.id) ?? null,
    isBanner: bannerKeys.has(image.key),
  }));

  return {
    rows,
    hasMore,
    nextCursor: hasMore ? page[page.length - 1].id : undefined,
  };
}

/**
 * Map item id → translated title for a set of items. Unlike
 * getArticleTranslations this reads only the title rows — no content blobs —
 * so it stays cheap when called for many items at once.
 */
export async function getTitleTranslations(
  db: Database,
  itemType: ArticleType,
  ids: string[],
  language: string,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await chunked(ids, (slice) =>
    db
      .select({ itemId: translations.itemId, value: translations.value })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, itemType),
          eq(translations.language, language),
          eq(translations.field, 'title'),
          isNotNull(translations.value),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  return new Map(rows.map((r) => [r.itemId, r.value!]));
}

/**
 * Sentinel `model` for a localized image supplied by hand in the admin (an
 * uploaded raster, or the output of an admin-triggered regeneration the operator
 * has committed to). The localize step treats a row with this model as settled —
 * so the nightly pipeline never silently overwrites a manual override — while an
 * explicit admin "Regenerate" still forces past it (see localizeImages `force`).
 */
export const MANUAL_IMAGE_MODEL = 'manual';

/** Upsert a per-image translation row (item_type='image', item_id=image id). */
export async function upsertImageTranslation(
  db: Database,
  params: {
    imageId: number;
    language: string;
    field: 'text' | 'url';
    value: string;
    model: string;
  },
): Promise<void> {
  const now = Temporal.Now.instant();
  await db
    .insert(translations)
    .values({
      itemType: 'image',
      itemId: String(params.imageId),
      language: params.language,
      field: params.field,
      state: 'done',
      value: params.value,
      translatedAt: now,
      model: params.model,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        translations.itemType,
        translations.itemId,
        translations.language,
        translations.field,
      ],
      set: {
        state: 'done',
        error: null,
        value: params.value,
        translatedAt: now,
        model: params.model,
        updatedAt: now,
      },
    });
}

/* ------------------------------------------------------------------ *
 * Rotation banners — the home-page carousel (see schema/banners.ts).
 * ------------------------------------------------------------------ */

/** A banner as scraped from the source rotation page. */
export type BannerListItem = {
  imageKey: string;
  linkUrl: string | null;
  linkTopicId: string | null;
  altJa: string;
  sortOrder: number;
  publishedAt: Temporal.Instant | null;
};

/**
 * Upsert the current rotation banners (keyed by imageKey), marking each active,
 * then deactivate any banner no longer in the set — so the carousel reflects the
 * live rotation while keeping stale rows (and their localized images) around.
 */
export async function syncBanners(
  db: Database,
  items: BannerListItem[],
): Promise<void> {
  const now = Temporal.Now.instant();
  for (const item of items) {
    await db
      .insert(banners)
      .values({ ...item, active: true, updatedAt: now })
      .onConflictDoUpdate({
        target: banners.imageKey,
        set: {
          linkUrl: item.linkUrl,
          linkTopicId: item.linkTopicId,
          altJa: item.altJa,
          sortOrder: item.sortOrder,
          publishedAt: item.publishedAt,
          active: true,
          updatedAt: now,
        },
      });
  }

  const keep = items.map((i) => i.imageKey);
  await db
    .update(banners)
    .set({ active: false, updatedAt: now })
    .where(
      keep.length > 0
        ? and(eq(banners.active, true), notInArray(banners.imageKey, keep))
        : eq(banners.active, true),
    );
}
