/**
 * Article lifecycle queries — the news/topic/playguide domain that spans three
 * tables and so can't live in any single schema file: list-scrape upserts,
 * block-tree writes, and body invalidation. Every blocks_ja writer keeps the
 * article_images reverse index in sync via syncArticleImages. Table-scoped
 * query helpers live beside their schema files (DQX-51: schema/*.queries.ts,
 * reset-events.ts); recheck scheduling lives in ./recheck.
 */

import { eq, inArray } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import type { Block } from '@hiroba/richtext';

import type { Database } from '../client';
import { chunked } from '../d1-limits';
import { syncArticleImages } from '../schema/article-images';
import { newsItems, type ListItem, type NewsItem } from '../schema/news-items';
import {
  playguides,
  type NewPlayguide,
  type Playguide,
} from '../schema/playguides';
import { topics, type NewTopic, type Topic } from '../schema/topics';

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
