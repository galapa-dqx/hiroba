/**
 * images — one row per render of an image source: the mirrored original
 * (`language` NULL) and every localized raster (`language` = its target).
 * Introduced in DQX-45, when a render became a first-class entity instead of a
 * magic `url` string on a `translations` row.
 *
 * The `id` is a client-allocated UUID (crypto.randomUUID()): allocating it up
 * front lets the render's row and all its `image_files` rows land in ONE
 * `db.batch` (atomic on D1) — a render either exists complete or never existed,
 * so there are no half-written cruft rows.
 *
 * Serving is latest-wins: the newest render per (source_id, language) is the one
 * served (order by created_at DESC, id tiebreak) — no `current` flag, no state
 * columns. Flow owns in-flight/failure (hub keyed dedup + run errors); a
 * superseded render just lingers until DQX-47 prunes it.
 *
 * `model` carries the skip identity (gpt-image-2 / 'manual' / NULL for mirrors)
 * — the localize step regenerates only when the newest render's model differs.
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { instant } from '../types/instant';
import { imageSources } from './image-sources';

export const images = sqliteTable(
  'images',
  {
    // Client-allocated UUID — see the file header (atomic complete-at-birth).
    id: text('id').primaryKey(),

    // The source this renders (image_sources.id).
    sourceId: integer('source_id')
      .notNull()
      .references(() => imageSources.id),

    // Target language, or NULL for the mirrored original.
    language: text('language'),

    // Skip identity: 'gpt-image-2' | 'manual' | NULL (mirrors).
    model: text('model'),

    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    // Latest-wins serving + per-language skip lookups walk (source, language)
    // newest-first.
    index('images_by_source_language').on(
      table.sourceId,
      table.language,
      table.createdAt,
    ),
  ],
);

export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;
