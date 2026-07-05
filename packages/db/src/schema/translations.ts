/**
 * Translations table schema.
 *
 * Uses a composite primary key (itemType, itemId, language, field) to support:
 * - Multiple content types (news, topics, events)
 * - Multiple languages per item
 * - Different translatable fields per item type
 */

import { and, eq, sql } from 'drizzle-orm';
import { check, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type Temporal } from 'temporal-polyfill';

import type { PhaseState } from '@hiroba/shared';

import type { Database } from '../client';
import { instant } from '../types/instant';

export const translations = sqliteTable(
  'translations',
  {
    // Composite key components
    itemType: text('item_type').notNull(), // "news", "topic", "event", or "image"
    itemId: text('item_id').notNull(), // FK to news_items.id, topics.id, events.id, or images.id
    language: text('language').notNull(), // e.g., "en"
    field: text('field').notNull(), // e.g., "title", "content"

    // Pipeline state. A row exists from the moment a step starts working on it;
    // `value` lands only on done. A re-translation flips state back to running
    // but keeps the previous value (stale-while-revalidate for readers).
    state: text('state').$type<PhaseState>().notNull().default('pending'),
    error: text('error'), // failure detail when state='failed'

    // Translated value — NULL until first completed.
    value: text('value'),

    // Tracking. translatedAt/model mark the last successful output (NULL until
    // then); updatedAt tracks every state change (staleness detection).
    translatedAt: instant('translated_at'), // epoch ms (Temporal.Instant)
    model: text('model'), // AI model used for translation (e.g., "gpt-4o")
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemType, table.itemId, table.language, table.field],
    }),
    // Mirrors migration 0012: done rows always carry their output. One-way on
    // purpose — running rows may keep a stale value.
    check(
      'translations_done_has_value',
      sql`${table.state} <> 'done' OR (${table.value} IS NOT NULL AND ${table.translatedAt} IS NOT NULL AND ${table.model} IS NOT NULL)`,
    ),
  ],
);

// Type exports
export type Translation = typeof translations.$inferSelect;
export type NewTranslation = typeof translations.$inferInsert;
export type ItemType = 'news' | 'topic' | 'event' | 'image';
// news/topic bodies use 'title' | 'content'; per-image (item_type='image') uses
// 'text' (translated spans) | 'url' (localized image R2 key).
export type TranslationField = 'title' | 'content' | 'text' | 'url';

/** Result for a single translated field */
export type FieldTranslation = {
  value: string;
  translatedAt: Temporal.Instant;
  model: string;
};

/** Map of field name to translation result */
export type FieldTranslations = Partial<Record<string, FieldTranslation>>;

/**
 * Delete all translations for an item.
 */
export async function deleteTranslation(
  db: Database,
  itemId: string,
  language: string,
  itemType: ItemType = 'news',
): Promise<boolean> {
  const result = await db
    .delete(translations)
    .where(
      and(
        eq(translations.itemType, itemType),
        eq(translations.itemId, itemId),
        eq(translations.language, language),
      ),
    )
    .returning({ itemId: translations.itemId });

  return result.length > 0;
}
