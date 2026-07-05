/**
 * Images table — one canonical row per distinct image (keyed by a surrogate id,
 * with the imageKey `<host>/<path>` as the natural unique key). Holds the source
 * (JA) transcription, deduped across topics. Whether an image is worth localizing
 * ("has >=1 Japanese span") is derived from `textsJa` at the point of use.
 *
 * The English outputs live in the `translations` table, keyed by this row's id:
 *   (item_type='image', item_id=<id>, language='en', field='text')  → EN spans
 *   (item_type='image', item_id=<id>, language='en', field='url')   → R2 key of
 *                                                                      the localized image
 */

import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { instant } from '../types/instant';
import { json } from '../types/json';

export const images = sqliteTable(
  'images',
  {
    // Surrogate primary key (translations.item_id references this, kept short).
    id: integer('id').primaryKey({ autoIncrement: true }),

    // Natural key — the imageKey <host>/<path> (see @hiroba/richtext imageKey).
    key: text('key').notNull().unique(),

    // Transcribed source spans. NULL = not yet transcribed; [] = transcribed, no text.
    textsJa: json<string[]>('texts_ja'),

    transcribeModel: text('transcribe_model'),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    check(
      'images_texts_ja_json',
      sql`${table.textsJa} IS NULL OR json_valid(${table.textsJa})`,
    ),
  ],
);

export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;
