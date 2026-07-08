/**
 * Topics table - stores scraped rich-text /topics/detail/ content.
 *
 * Supports two-phase scraping (mirrors news_items):
 * - Phase 1 (list scraping): id, titleJa, publishedAt (category optional)
 * - Phase 2 (body scraping): blocksJa (the JSON block tree) on demand
 *
 * Localized output lives in the `translations` table (itemType='topic',
 * field='title'|'content'); there is no blocks_en column.
 */

import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { Block } from '@hiroba/richtext';
import type { PhaseState } from '@hiroba/shared';

import { instant } from '../types/instant';
import { json } from '../types/json';

export const topics = sqliteTable(
  'topics',
  {
    // Primary identifier - 32-char hex from source URL
    id: text('id').primaryKey(),

    // From list page (Phase 1)
    publishedAt: instant('published_at').notNull(), // epoch ms (Temporal.Instant)
    titleJa: text('title_ja').notNull(),

    // From detail page (Phase 2) - NULL until fetched. Canonical source tree.
    blocksJa: json<Block[]>('blocks_ja'),

    // Optional taxonomy (later enhancement)
    category: text('category'),

    // Body fetch tracking
    bodyFetchedAt: instant('body_fetched_at'), // epoch ms (Temporal.Instant)
    fetchState: text('fetch_state')
      .$type<PhaseState>()
      .notNull()
      .default('pending'),

    // Recheck tracking (see @hiroba/shared freshness): when the source page
    // was last polled for edits, and when polled content last differed (NULL
    // = never seen to change; the schedule anchors on published_at).
    bodyCheckedAt: instant('body_checked_at'),
    bodyChangedAt: instant('body_changed_at'),
  },
  // Mirrors the CHECK constraints in migration 0009. Drizzle has no STRICT
  // table option, so strict typing lives only in the raw migration.
  (table) => [
    check('topics_id_len', sql`length(${table.id}) = 32`),
    check(
      'topics_blocks_ja_json',
      sql`${table.blocksJa} IS NULL OR json_valid(${table.blocksJa})`,
    ),
    index('topics_published_at_idx').on(table.publishedAt),
  ],
);

// Type exports
export type Topic = typeof topics.$inferSelect;
export type NewTopic = typeof topics.$inferInsert;

/** Phase 1 (list scraping) fields only */
export type TopicListItem = Pick<
  Topic,
  'id' | 'titleJa' | 'publishedAt' | 'category'
>;
