/**
 * image_sources — one row per stored R2 image object, grouped by the primary
 * (fallback) object's key: the primary row has `key = groupKey`, the rest are
 * variants of the same raster — alternate encodings (AVIF) and/or resized
 * fit-inside renditions, distinguished by their mime + dimensions. This is
 * the metadata a `<picture>` tag wants — each variant's MIME plus its pixel
 * dimensions — and, incidentally, an inventory of the bucket.
 *
 * Nothing points INTO this table by id: `images.key` (mirrored originals)
 * and the value of an image's `url` translation row (localized renders)
 * already name the primary object, so they double as `groupKey` lookups.
 *
 * A group's rows are written complete-at-birth — variants encoded and stored,
 * then the whole row set inserted in one call — so the presence of the
 * primary row is the "attempted" marker (no sentinels), and a raster that
 * can't have an AVIF (animated GIF, encode no smaller) is simply a group
 * with only its primary row. Registration is NOT ordered against the pointer
 * that makes a render reachable (url row / mirror state): the web renders
 * only recorded rows, so an unregistered render serves as a bare <img> until
 * its rows land. A regeneration mints a new versioned key = a new group; the
 * old group's rows orphan alongside the old objects, prunable together.
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { instant } from '../types/instant';

export const imageSources = sqliteTable(
  'image_sources',
  {
    // R2 object key of this variant.
    key: text('key').primaryKey(),

    // The primary object's key (primary row: key = groupKey).
    groupKey: text('group_key').notNull(),

    // Content type of the stored bytes.
    mime: text('mime').notNull(),

    // Pixel dimensions; NULL when unmeasurable (e.g. SVG).
    width: integer('width'),
    height: integer('height'),

    // Object size, for ops/inventory queries.
    bytes: integer('bytes'),

    createdAt: instant('created_at').notNull(),
  },
  (table) => [index('image_sources_by_group').on(table.groupKey)],
);

export type ImageSource = typeof imageSources.$inferSelect;
export type NewImageSource = typeof imageSources.$inferInsert;
