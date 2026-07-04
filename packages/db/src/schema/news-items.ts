/**
 * News items table - stores scraped news metadata and content.
 *
 * Supports two-phase scraping:
 * - Phase 1 (list scraping): Populates id, titleJa, category, publishedAt
 * - Phase 2 (body scraping): Populates blocksJa (the JSON block tree) on demand
 *
 * Localized output lives in the `translations` table (itemType='news',
 * field='title'|'content'); the content translation stores the block tree as
 * JSON, same as topics.
 */

import { sql } from 'drizzle-orm';
import { check, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { Block } from '@hiroba/richtext';

import { instant } from '../types/instant';
import { json } from '../types/json';

export const newsItems = sqliteTable(
  'news_items',
  {
    // Primary identifier - 32-char hex from source URL
    id: text('id').primaryKey(),

    // From list page (Phase 1)
    titleJa: text('title_ja').notNull(),
    category: text('category').notNull(), // news|event|update|maintenance
    publishedAt: instant('published_at').notNull(), // epoch ms (Temporal.Instant)

    // From detail page (Phase 2) - NULL until fetched. Canonical source tree.
    blocksJa: json<Block[]>('blocks_ja'),

    // Body fetch tracking
    bodyFetchedAt: instant('body_fetched_at'), // epoch ms (Temporal.Instant)
  },
  // Mirrors the CHECK constraints in migration 0011. Drizzle has no STRICT
  // table option, so strict typing lives only in the raw migration.
  (table) => [
    check('news_items_id_len', sql`length(${table.id}) = 32`),
    check(
      'news_items_category_valid',
      sql`${table.category} IN ('news', 'event', 'update', 'maintenance')`,
    ),
    check(
      'news_items_blocks_ja_json',
      sql`${table.blocksJa} IS NULL OR json_valid(${table.blocksJa})`,
    ),
  ],
);

// Type exports
export type NewsItem = typeof newsItems.$inferSelect;
export type NewNewsItem = typeof newsItems.$inferInsert;

/** Phase 1 (list scraping) fields only */
export type ListItem = Pick<
  NewsItem,
  'id' | 'titleJa' | 'category' | 'publishedAt'
>;
