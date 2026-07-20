/**
 * image_files — one row per stored R2 object belonging to a render (DQX-45).
 * The `key` is the object's R2 key (its primary key); `image_id` points at the
 * `images` render that owns it.
 *
 * `is_primary` marks the byte-exact raster: the `<img src>` fallback, the
 * dimensions source, and the baseline DQX-49's encode-skip + `<source>` rules
 * measure against. In DQX-45 every render has exactly its one primary file;
 * DQX-49 adds AVIF + fit renditions as additional (non-primary) files here.
 *
 * `mime`/`width`/`height`/`bytes` are measured at write time via the Cloudflare
 * Images binding — a new render lands complete. Rows SEEDED by the 0023
 * migration (originals + already-localized rasters) carry NULLs until DQX-49's
 * backfill measures them.
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { instant } from '../types/instant';
import { images } from './images';

export const imageFiles = sqliteTable(
  'image_files',
  {
    // The stored object's R2 key.
    key: text('key').primaryKey(),

    // The render this file belongs to (images.id).
    imageId: text('image_id')
      .notNull()
      .references(() => images.id),

    // The byte-exact raster (<img src> fallback + dimension source).
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull(),

    // Measured metadata — NULL on migration-seeded rows until DQX-49 backfills.
    mime: text('mime'),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes'),

    createdAt: instant('created_at').notNull(),
  },
  (table) => [index('image_files_by_image').on(table.imageId)],
);

export type ImageFile = typeof imageFiles.$inferSelect;
export type NewImageFile = typeof imageFiles.$inferInsert;
