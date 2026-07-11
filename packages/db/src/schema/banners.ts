/**
 * Rotation banners — the promotional carousel scraped from
 * https://hiroba.dqx.jp/sc/rotationbanner and shown on our home page.
 *
 * The banner *image* is a plain row in the shared `images` table (keyed by
 * `imageKey`), so it mirrors/transcribes/localizes through the same pipeline and
 * its translated variant is served from `l10n/<lang>/<key>` like any article
 * image. This table only holds banner metadata: where it links, its caption, and
 * its position in the rotation. Banners come and go, so `active` marks the ones
 * currently in the source rotation (stale ones are deactivated, not deleted, so
 * their localized images stay cached for a re-appearance).
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

import { instant } from '../types/instant';

export const banners = sqliteTable(
  'banners',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // imageKey (`<host>/<path>`) — joins to images.key; the banner's identity.
    imageKey: text('image_key').notNull().unique(),
    // The raw link target from the source (a topics/detail URL, usually).
    linkUrl: text('link_url'),
    // The 32-char topic id, when the link points at a topic we can render.
    linkTopicId: text('link_topic_id'),
    // Japanese caption (the source <img alt>), used as a11y fallback text.
    altJa: text('alt_ja').notNull(),
    // Position in the source rotation (0-based, ascending). The rotation order
    // is editorially curated and stable across requests, not chronological — so
    // it drives the carousel's display order. Rewritten wholesale each scrape;
    // deliberately not unique (a re-sort transiently collides positions).
    sortOrder: integer('sort_order').notNull(),
    // Posting date parsed from the banner filename (banner_rotation_YYYYMMDD_…);
    // stable recency metadata, null when the filename doesn't encode one.
    publishedAt: instant('published_at'),
    // Whether the banner is currently in the source rotation.
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    check(
      'banners_link_topic_id_len',
      sql`${table.linkTopicId} IS NULL OR length(${table.linkTopicId}) = 32`,
    ),
    index('banners_active_order_idx').on(table.active, table.sortOrder),
  ],
);

export type Banner = typeof banners.$inferSelect;
export type NewBanner = typeof banners.$inferInsert;
