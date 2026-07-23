/**
 * D1 query owned by the title backfill flow (see title-backfill-flow.ts) — its
 * only consumer, so it lives here rather than in @hiroba/db (DQX-53).
 */

import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import {
  newsItems,
  playguides,
  topics,
  translations,
  type ArticleType,
  type Database,
} from '@hiroba/db';

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
  const table =
    itemType === 'news'
      ? newsItems
      : itemType === 'topic'
        ? topics
        : playguides;
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
