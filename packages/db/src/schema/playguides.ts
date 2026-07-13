/**
 * Playguides table — stores scraped rich-text /sc/public/playguide/ content.
 *
 * Structurally a sibling of `topics` (a title + a JSON `blocks_ja` tree,
 * two-phase scraping, the same recheck columns), with three deliberate
 * differences that reflect what playguides are:
 * - `id` is the page **slug** (`guide01`, `guide_4_2`, `wintrial_1`), not a
 *   32-char hex id — so the length-32 CHECK is replaced by a slug charset guard.
 * - `publishedAt` is **nullable**: guides are static reference pages, not dated
 *   posts. Listing orders by `sortOrder` (crawl order) instead.
 * - `sortOrder` gives the discovery crawl a stable, human-ish ordering.
 *
 * Localized output lives in the `translations` table (itemType='playguide',
 * field='title'|'content'), exactly like topics.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

import type { Block } from '@hiroba/richtext';

import { instant } from '../types/instant';
import { json } from '../types/json';

export const playguides = sqliteTable(
  'playguides',
  {
    // Primary identifier — the page slug from the source URL.
    id: text('id').primaryKey(),

    // Crawl order (stable listing; guides have no publish date to sort by).
    sortOrder: integer('sort_order').notNull().default(0),

    // From the crawl (Phase 1) — nullable: guides aren't dated.
    publishedAt: instant('published_at'), // epoch ms (Temporal.Instant)
    titleJa: text('title_ja').notNull(),

    // From detail page (Phase 2) — NULL until fetched. Canonical source tree.
    blocksJa: json<Block[]>('blocks_ja'),

    // Body fetch tracking
    bodyFetchedAt: instant('body_fetched_at'), // epoch ms (Temporal.Instant)
    // Recheck tracking (see @hiroba/shared freshness): when the source page was
    // last polled for edits, and when polled content last differed.
    bodyCheckedAt: instant('body_checked_at'),
    bodyChangedAt: instant('body_changed_at'),
  },
  // Mirrors the CHECK constraints in migration 0017. Drizzle has no STRICT
  // table option, so strict typing lives only in the raw migration.
  (table) => [
    check(
      'playguides_id_slug',
      sql`length(${table.id}) BETWEEN 1 AND 64 AND ${table.id} NOT GLOB '*[^a-z0-9_]*'`,
    ),
    check(
      'playguides_blocks_ja_json',
      sql`${table.blocksJa} IS NULL OR json_valid(${table.blocksJa})`,
    ),
    index('playguides_sort_order_idx').on(table.sortOrder),
  ],
);

// Type exports
export type Playguide = typeof playguides.$inferSelect;
export type NewPlayguide = typeof playguides.$inferInsert;

/** Phase 1 (crawl) fields only */
export type PlayguideListItem = Pick<Playguide, 'id' | 'titleJa' | 'sortOrder'>;
