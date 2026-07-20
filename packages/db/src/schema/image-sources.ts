/**
 * image_sources — one canonical row per distinct upstream image (keyed by a
 * surrogate id, with the imageKey `<host>/<path>` as the natural unique key).
 * Holds the source (JA) transcription, deduped across topics. Whether an image
 * is worth localizing ("has >=1 Japanese span") is derived from `textsJa` at the
 * point of use.
 *
 * This is the DQX-9 `images` table, renamed (DQX-45): a source is no longer a
 * render. Each render — the mirrored original and every localized raster — is
 * its own `images` row (schema/images.ts) pointing back here, with its stored
 * R2 objects in `image_files`. The per-source translated text spans still live
 * in `translations` (item_type='image', item_id=<this id>, field='text'); the
 * `url` field is gone (renders own their R2 keys now).
 *
 * `mirror_state` / `transcribe_state` linger for the admin panels until DQX-46
 * drops them; serving no longer reads them (an original `images` row's
 * existence is the mirror-done signal, and Flow owns in-flight/failure).
 */

import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { PhaseState } from '@hiroba/shared';

import { instant } from '../types/instant';
import { json } from '../types/json';

export const imageSources = sqliteTable(
  'image_sources',
  {
    // Surrogate primary key (translations.item_id and images.source_id
    // reference this, kept short).
    id: integer('id').primaryKey({ autoIncrement: true }),

    // Natural key — the imageKey <host>/<path> (see @hiroba/richtext imageKey).
    key: text('key').notNull().unique(),

    // Transcribed source spans. NULL = not yet transcribed; [] = transcribed, no text.
    textsJa: json<string[]>('texts_ja'),

    transcribeModel: text('transcribe_model'),
    mirrorState: text('mirror_state')
      .$type<PhaseState>()
      .notNull()
      .default('pending'),
    transcribeState: text('transcribe_state')
      .$type<PhaseState>()
      .notNull()
      .default('pending'),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    check(
      'image_sources_texts_ja_json',
      sql`${table.textsJa} IS NULL OR json_valid(${table.textsJa})`,
    ),
  ],
);

export type ImageSource = typeof imageSources.$inferSelect;
export type NewImageSource = typeof imageSources.$inferInsert;
