/**
 * D1 queries owned by the glossary regenerate flow (see glossary-regen-flow.ts)
 * — its only consumer, so they live here rather than in @hiroba/db (DQX-53).
 * Both walk the *entire* affected set via keyset pagination; nothing is capped
 * away, so no affected article or image is ever silently skipped.
 */

import { and, asc, gt, or, sql } from 'drizzle-orm';

import {
  imageSources,
  newsItems,
  playguides,
  topics,
  type ArticleType,
  type Database,
} from '@hiroba/db';

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
 * Matches with `instr` (like the glossary resolver's own matching, so no LIKE
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
    .select({ id: imageSources.id, textsJa: imageSources.textsJa })
    .from(imageSources)
    .where(
      and(
        sql`instr(${imageSources.textsJa}, ${sourceText}) > 0`,
        afterId != null ? gt(imageSources.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(imageSources.id))
    .limit(limit)
    .all();
}
