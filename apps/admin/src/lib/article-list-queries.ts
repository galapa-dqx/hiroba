/**
 * Lightweight article lists for the admin UI — admin-only, so they live here
 * rather than in the shared db package (DQX-54). No block trees on the wire:
 * each row carries a `hasBody` flag plus per-item translation status.
 */

import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import {
  chunked,
  newsItems,
  playguides,
  topics,
  translations,
  type Database,
} from '@hiroba/db';

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

/**
 * Lightweight playguide list for the admin UI (mirrors listTopicsAdmin): a
 * `hasBody` flag plus per-item translation status, no block trees on the wire.
 * Not cursor-paginated — the guide set is small and bounded.
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
