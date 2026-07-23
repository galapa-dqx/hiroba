/**
 * Article queries — the news/topic/playguide domain: list-scrape upserts,
 * body writes (every blocks_ja writer keeps the article_images reverse index
 * in sync via syncArticleImages), and recheck scheduling. Table-scoped query
 * helpers live beside their schema files (DQX-51: schema/*.queries.ts,
 * reset-events.ts).
 */

import { eq, inArray, isNotNull } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import type { Block } from '@hiroba/richtext';
import { getNextCheckTime } from '@hiroba/shared';

import type { Database } from './client';
import { chunked } from './d1-limits';
import { syncArticleImages } from './schema/article-images';
import { newsItems, type ListItem, type NewsItem } from './schema/news-items';
import {
  playguides,
  type NewPlayguide,
  type Playguide,
} from './schema/playguides';
import { topics, type NewTopic, type Topic } from './schema/topics';

/** The three body-bearing article types, sharing the pipeline (news/topic/playguide). */
export type ArticleType = 'news' | 'topic' | 'playguide';

/**
 * The source table for a body-bearing item type. All three share the columns the
 * pipeline touches (id, titleJa, blocksJa, body* tracking); callers
 * that reach for a type-specific column (news `category`, dated `publishedAt`)
 * branch explicitly instead of going through here. Exported for the admin-only
 * queries that live in apps/admin/src/lib (DQX-54) and iterate one table per
 * ArticleType the same way.
 */
export function articleTable(itemType: ArticleType) {
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

/** A news item plus its resolved current-language title (null ⇒ show titleJa).
 *  Produced by flattening the `title` relation (see relations.ts) with
 *  `withLocalizedTitle` at list call sites. */
export type LocalizedNewsItem = NewsItem & { localizedTitle: string | null };

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

/** Every fetched article of every type, with its recheck schedule computed.
 *  Exported for the admin dashboard's getStats (apps/admin, DQX-54), which
 *  buckets the whole domain per item type — a shape getRecheckQueue's
 *  due/upcoming/retired split doesn't preserve. */
export async function collectRecheckEntries(
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

/** A topic plus its resolved current-language title (null ⇒ show titleJa). */
export type LocalizedTopic = Topic & { localizedTitle: string | null };

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
export type LocalizedPlayguide = Playguide & { localizedTitle: string | null };
