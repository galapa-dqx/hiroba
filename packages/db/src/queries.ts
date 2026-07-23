/**
 * Database queries for news items.
 */

import { and, eq, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Temporal } from 'temporal-polyfill';

import { collectImages, imageKey, type Block } from '@hiroba/richtext';
import { getNextCheckTime, type PhaseState } from '@hiroba/shared';

import type { Database } from './client';
import { chunked, IN_CHUNK } from './d1-limits';
import { withLocalizedTitle } from './relations';
import {
  buildResetEvents,
  RESET_SOURCE_TYPE,
  type ResetTitleMap,
} from './reset-events';
import { articleImages } from './schema/article-images';
import { events, type Event, type NewEvent } from './schema/events';
import { imageFiles } from './schema/image-files';
import { imageSources, type ImageSource } from './schema/image-sources';
import { images } from './schema/images';
import { getEnabledLanguages } from './schema/languages';
import { newsItems, type ListItem, type NewsItem } from './schema/news-items';
import {
  playguides,
  type NewPlayguide,
  type Playguide,
} from './schema/playguides';
import { topics, type NewTopic, type Topic } from './schema/topics';
import {
  translations,
  type ItemType,
  type TranslationField,
} from './schema/translations';

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
export type EventWithTitle = Event & { localizedTitle: string | null };

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
  // Via the provenance relation, not events.source_id: a campaign mentioned
  // here but whose *primary* source is a different article (its own dedicated
  // page) must still appear in this article's rail.
  const rows = await db.query.events.findMany({
    where: { sources: { sourceType, sourceId } },
    with: { title: { where: { language }, columns: { value: true } } },
    orderBy: { startTime: 'asc' },
  });
  return rows.map(withLocalizedTitle);
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
  const rows = await db.query.events.findMany({
    where: {
      startTime: { lt: dayEnd },
      OR: [
        // Starts within the day (covers point-in-time events at 00:00)…
        { startTime: { gte: dayStart } },
        // …or began earlier and runs strictly past 00:00. An event ending
        // exactly at 00:00 belongs to the previous day, so it no longer shows
        // as a zero-height sliver pinned to the top of this one.
        { endTime: { gt: dayStart } },
      ],
    },
    with: { title: { where: { language }, columns: { value: true } } },
    orderBy: { startTime: 'asc' },
  });
  return rows.map(withLocalizedTitle);
}

// ── Reset milestones ────────────────────────────────────────────────────────
// Admin-managed recurring resets. The definitions live in `reset_milestones`;
// `refreshResetEvents` (workflow cron) materializes the next horizon of their
// occurrences into `events` as `mark` rows via `buildResetEvents`, then swaps
// them in with `replaceResetEvents`. See reset-events.ts.

/**
 * Swap in a freshly materialized set of reset `mark` events (sourceType='reset')
 * for the forward window starting at `from`: delete the existing reset rows from
 * `from` onward (clearing anything a disabled/edited def no longer covers) with
 * their title translations, then insert the new rows and per-language titles.
 * Batched to stay under D1's ~100 bound-parameter cap; deterministic ids let a
 * partial failure self-heal on the next run.
 */
async function replaceResetEvents(
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
const RESET_HORIZON_DAYS = 120;

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
 * Upsert a finished translation row for any non-image item type, landing
 * state='done' with the value and model attribution. Used by the eager title
 * step (DQX-11) so it can write news and topic titles through one helper.
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
 * Ensure an image-source row exists for every key, so the pipeline has rows to
 * hang transcription state (and renders) on. Existing rows (any state) are left
 * untouched.
 */
export async function ensureImageSourceRows(
  db: Database,
  keys: string[],
): Promise<void> {
  const now = Temporal.Now.instant();
  // Batched inserts: each row binds several parameters, so keep batches small
  // enough to stay under D1's per-statement cap.
  const ROWS_PER_INSERT = 20;
  for (let i = 0; i < keys.length; i += ROWS_PER_INSERT) {
    await db
      .insert(imageSources)
      .values(
        keys
          .slice(i, i + ROWS_PER_INSERT)
          .map((key) => ({ key, updatedAt: now })),
      )
      .onConflictDoNothing();
  }
}

/** Set the transcription state on an image-source row (running/failed transitions). */
export async function setImageTranscribeState(
  db: Database,
  key: string,
  state: Exclude<PhaseState, 'done'>, // 'done' lands with texts via upsertImageTranscription
): Promise<void> {
  await db
    .update(imageSources)
    .set({ transcribeState: state, updatedAt: Temporal.Now.instant() })
    .where(eq(imageSources.key, key));
}

/** Set the mirror (CDN → R2 copy) state on an image-source row. */
export async function setImageMirrorState(
  db: Database,
  key: string,
  state: PhaseState,
): Promise<void> {
  await db
    .update(imageSources)
    .set({ mirrorState: state, updatedAt: Temporal.Now.instant() })
    .where(eq(imageSources.key, key));
}

/* ------------------------------------------------------------------ *
 * Image sources (per-distinct-image transcription state) + renders
 * ------------------------------------------------------------------ */

/**
 * Record an image source's transcription (get-or-create by key). `textsJa` is
 * every transcribed span ([] if none). Returns the surrogate source id (used as
 * translations.item_id and images.source_id). Whether it's worth localizing is
 * derived from textsJa.
 */
export async function upsertImageTranscription(
  db: Database,
  params: { key: string; textsJa: string[]; model: string },
): Promise<number> {
  const now = Temporal.Now.instant();
  const rows = await db
    .insert(imageSources)
    .values({
      key: params.key,
      textsJa: params.textsJa,
      transcribeModel: params.model,
      transcribeState: 'done',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: imageSources.key,
      set: {
        textsJa: params.textsJa,
        transcribeModel: params.model,
        transcribeState: 'done',
        updatedAt: now,
      },
    })
    .returning({ id: imageSources.id });
  return rows[0].id;
}

/* ------------------------------------------------------------------ *
 * Renders (images + image_files) — one render per (source, language),
 * latest-wins serving, complete-at-birth.
 * ------------------------------------------------------------------ */

/** Newest-wins comparison for renders: created_at, then id as tiebreak.
 *  Exported for the admin-only render queries in apps/admin/src/lib (DQX-54),
 *  which pick "the newest localized render" the same way. */
export function renderIsNewer(
  a: { createdAt: Temporal.Instant; id: string },
  b: { createdAt: Temporal.Instant; id: string },
): boolean {
  const c = Temporal.Instant.compare(a.createdAt, b.createdAt);
  return c > 0 || (c === 0 && a.id > b.id);
}

/** One stored file of a render — measured at write time (NULLs on seeds). */
export type RenderFileInput = {
  key: string;
  isPrimary: boolean;
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
};

/**
 * Insert one render (an `images` row) plus all its `image_files` in ONE atomic
 * D1 batch — complete-at-birth, so a render either exists with its files or
 * never existed. `id` is client-allocated (crypto.randomUUID()); `language` is
 * NULL for a mirrored original.
 */
export async function insertImageRender(
  db: Database,
  params: {
    id: string;
    sourceId: number;
    language: string | null;
    model: string | null;
    files: RenderFileInput[];
  },
): Promise<void> {
  const now = Temporal.Now.instant();
  const statements: BatchItem<'sqlite'>[] = [
    db.insert(images).values({
      id: params.id,
      sourceId: params.sourceId,
      language: params.language,
      model: params.model,
      createdAt: now,
    }),
    ...params.files.map((f) =>
      db.insert(imageFiles).values({
        key: f.key,
        imageId: params.id,
        isPrimary: f.isPrimary,
        mime: f.mime,
        width: f.width,
        height: f.height,
        bytes: f.bytes,
        createdAt: now,
      }),
    ),
  ];
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

/** Whether a source already has a mirrored-original render (language NULL). One
 *  original per source — mirror creates it once, so re-mirrors don't duplicate
 *  it (its primary file sits at the fixed source key). */
export async function hasOriginalRender(
  db: Database,
  sourceId: number,
): Promise<boolean> {
  const row = await db
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.sourceId, sourceId), isNull(images.language)))
    .limit(1)
    .get();
  return !!row;
}

/** The served primary file of a render — the object key + measured metadata. */
export type ServedFile = {
  key: string;
  mime: string | null;
  width: number | null;
  height: number | null;
};

/** The renders serving a source in one language: the newest localized render
 *  (language match) and the mirrored original (language NULL) fallback. */
export type ServedRenders = {
  localized: ServedFile | null;
  original: ServedFile | null;
};

/**
 * Latest-wins serving for a set of sources in one language. For each source
 * returns the newest localized render's primary file (for `language`) and the
 * newest original's primary file (the mirrored fallback). Readers serve the
 * localized file on translated pages, else the original, else the raw source.
 */
export async function getServedImages(
  db: Database,
  sourceIds: number[],
  language: string,
): Promise<Map<number, ServedRenders>> {
  const result = new Map<number, ServedRenders>();
  if (sourceIds.length === 0) return result;

  const rows = await chunked(sourceIds, (slice) =>
    db
      .select({
        sourceId: images.sourceId,
        language: images.language,
        createdAt: images.createdAt,
        id: images.id,
        key: imageFiles.key,
        mime: imageFiles.mime,
        width: imageFiles.width,
        height: imageFiles.height,
      })
      .from(images)
      .innerJoin(
        imageFiles,
        and(eq(imageFiles.imageId, images.id), eq(imageFiles.isPrimary, true)),
      )
      .where(
        and(
          inArray(images.sourceId, slice),
          or(eq(images.language, language), isNull(images.language)),
        ),
      )
      .all(),
  );

  // Keep the newest render per (source, localized|original) bucket.
  const best = new Map<
    string,
    { createdAt: Temporal.Instant; id: string; file: ServedFile }
  >();
  for (const r of rows) {
    const mapKey = `${r.sourceId}:${r.language === null ? 'o' : 'l'}`;
    const cand = {
      createdAt: r.createdAt,
      id: r.id,
      file: { key: r.key, mime: r.mime, width: r.width, height: r.height },
    };
    const prev = best.get(mapKey);
    if (!prev || renderIsNewer(cand, prev)) best.set(mapKey, cand);
  }
  for (const sourceId of sourceIds) {
    result.set(sourceId, {
      localized: best.get(`${sourceId}:l`)?.file ?? null,
      original: best.get(`${sourceId}:o`)?.file ?? null,
    });
  }
  return result;
}

/**
 * Model of the newest render per (source, language) — the localize step's skip
 * identity (regenerate only when the newest render's model changed or none
 * exists). Sources without a localized render are absent from the map.
 */
export async function getLatestRenderModels(
  db: Database,
  sourceIds: number[],
  language: string,
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  if (sourceIds.length === 0) return result;

  const rows = await chunked(sourceIds, (slice) =>
    db
      .select({
        sourceId: images.sourceId,
        model: images.model,
        createdAt: images.createdAt,
        id: images.id,
      })
      .from(images)
      .where(
        and(inArray(images.sourceId, slice), eq(images.language, language)),
      )
      .all(),
  );

  const best = new Map<
    number,
    { createdAt: Temporal.Instant; id: string; model: string | null }
  >();
  for (const r of rows) {
    const prev = best.get(r.sourceId);
    if (!prev || renderIsNewer(r, prev)) best.set(r.sourceId, r);
  }
  for (const [sourceId, v] of best) result.set(sourceId, v.model);
  return result;
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
      .update(imageSources)
      .set({ textsJa: spans.map((s) => s.text), updatedAt: now })
      .where(eq(imageSources.id, imageId)),
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

/** Look up image-source rows by their natural keys (imageKey). */
export async function getImageSourcesByKeys(
  db: Database,
  keys: string[],
): Promise<ImageSource[]> {
  return chunked(keys, (slice) =>
    db
      .select()
      .from(imageSources)
      .where(inArray(imageSources.key, slice))
      .all(),
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
 * Map image-source id → its translated `text` spans (the JSON array string) for
 * one language. Only the translated-spans field lives in `translations` now;
 * the localized raster lives on renders (see getServedImages).
 */
export async function getImageTranslations(
  db: Database,
  imageIds: number[],
  language: string,
): Promise<Map<number, string>> {
  const rows = await chunked(imageIds.map(String), (slice) =>
    db
      .select({ itemId: translations.itemId, value: translations.value })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'image'),
          eq(translations.language, language),
          eq(translations.field, 'text'),
          isNotNull(translations.value),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  return new Map(rows.map((r) => [Number(r.itemId), r.value!]));
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

/**
 * Upsert an image source's translated-spans row (item_type='image', field='text',
 * item_id=source id). The localized raster is written as a render, not here.
 */
export async function upsertImageTranslation(
  db: Database,
  params: {
    imageId: number;
    language: string;
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
      field: 'text',
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
