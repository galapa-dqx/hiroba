/**
 * Database queries for news items.
 */

import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  lt,
  sql,
} from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import type { Block } from '@hiroba/richtext';
import {
  getNextCheckTime,
  isDueForCheck,
  type Category,
  type PhaseState,
} from '@hiroba/shared';

import type { Database } from './client';
import { images, type Image } from './schema/images';
import { newsItems, type ListItem, type NewsItem } from './schema/news-items';
import { topics, type NewTopic, type Topic } from './schema/topics';
import {
  translations,
  type ItemType,
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
 * Fetch `{id, titleJa}` for a set of items of one type — the input the title
 * translation workflow needs (its params carry only ids, so it reads current
 * titles here). Missing ids are simply omitted.
 */
export async function getItemTitles(
  db: Database,
  itemType: 'news' | 'topic',
  ids: string[],
): Promise<Array<{ id: string; titleJa: string }>> {
  if (ids.length === 0) return [];
  const table = itemType === 'news' ? newsItems : topics;
  return chunked(ids, (slice) =>
    db
      .select({ id: table.id, titleJa: table.titleJa })
      .from(table)
      .where(inArray(table.id, slice))
      .all(),
  );
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
        .where(isNotNull(newsItems.blocksJa))
        .get(),
      db
        .select({ count: sql<number>`count(DISTINCT item_id)` })
        .from(translations)
        .where(
          and(
            eq(translations.itemType, 'news'),
            eq(translations.language, 'en'),
            eq(translations.state, 'done'),
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
 * Stats for the admin Topics dashboard.
 */
export async function getTopicStats(db: Database): Promise<{
  total: number;
  withBody: number;
  translated: number;
}> {
  const [totalResult, withBodyResult, translatedResult] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(topics)
      .get(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(topics)
      .where(isNotNull(topics.blocksJa))
      .get(),
    db
      .select({ count: sql<number>`count(DISTINCT item_id)` })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'topic'),
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
  if (topic.fetchState !== undefined) set.fetchState = topic.fetchState;

  await db
    .insert(topics)
    .values(topic)
    .onConflictDoUpdate({ target: topics.id, set });
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
  await db.update(topics).set({ blocksJa: blocks }).where(eq(topics.id, id));
}

/**
 * Get a single topic by ID.
 */
export async function getTopic(
  db: Database,
  id: string,
): Promise<Topic | null> {
  const result = await db.select().from(topics).where(eq(topics.id, id)).get();
  return result ?? null;
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
 * Lightweight paginated topic list for the admin UI. Avoids pulling the full
 * block tree — derives a `hasBody` flag and joins per-item translation status.
 */
export async function listTopicsAdmin(
  db: Database,
  options: { limit?: number; cursor?: string } = {},
): Promise<{
  items: Array<{
    id: string;
    titleJa: string;
    publishedAt: Temporal.Instant;
    hasBody: boolean;
    translated: boolean;
  }>;
  hasMore: boolean;
  nextCursor?: string;
}> {
  const limit = Math.min(options.limit ?? 50, 100);

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
      publishedAt: topics.publishedAt,
      hasBody: sql<number>`(${topics.blocksJa} IS NOT NULL)`,
    })
    .from(topics)
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

  // Stale-while-revalidate: a running re-translation keeps its previous value,
  // which is still the best thing to render. Only value-less rows are skipped.
  let title: string | null = null;
  let blocks: Block[] | null = null;
  for (const row of rows) {
    if (row.value === null) continue;
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

/** Set the article fetch state on a news item or topic. */
export async function setItemFetchState(
  db: Database,
  itemType: 'news' | 'topic',
  id: string,
  state: PhaseState,
): Promise<void> {
  const table = itemType === 'news' ? newsItems : topics;
  await db.update(table).set({ fetchState: state }).where(eq(table.id, id));
}

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
 * exhausted its retries doesn't leave titles stuck `running`. Only touches
 * `running` rows, so it never clobbers a sibling chunk's `done`.
 */
export async function resetRunningTitles(
  db: Database,
  itemType: 'news' | 'topic',
  itemIds: string[],
  language: string,
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
          eq(translations.language, language),
          eq(translations.field, 'title'),
          eq(translations.state, 'running'),
          inArray(translations.itemId, itemIds.slice(i, i + IN_CHUNK)),
        ),
      );
  }
}

/**
 * Terminal cleanup when a workflow dies: everything for this item still
 * marked in-flight (or never picked up) becomes `failed`, so SSE clients and
 * later triggers see a settled pipeline instead of an eternal `running`.
 * Scoped to the item's own rows — shared image rows are owned by whichever
 * workflow is actually touching them.
 */
export async function failPipelineStates(
  db: Database,
  itemType: 'news' | 'topic',
  itemId: string,
  language: string,
  error: string,
): Promise<void> {
  const now = Temporal.Now.instant();
  const table = itemType === 'news' ? newsItems : topics;
  await db
    .update(table)
    .set({ fetchState: 'failed' })
    .where(and(eq(table.id, itemId), eq(table.fetchState, 'running')));
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
