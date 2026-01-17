/**
 * Glossary table - stores translation term mappings.
 *
 * Used to ensure consistent translation of game-specific terms.
 * Composite primary key (sourceText, targetLanguage) allows
 * different translations for different target languages.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

import type { Database } from '../client';

export const glossary = sqliteTable(
  'glossary',
  {
    // Composite key components
    sourceText: text('source_text').notNull(), // Japanese term
    targetLanguage: text('target_language').notNull(), // e.g., "en"

    // Translation
    translatedText: text('translated_text').notNull(),

    // Tracking
    updatedAt: integer('updated_at').notNull(), // Unix timestamp
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.sourceText, table.targetLanguage],
    }),
  }),
);

// Type exports
export type GlossaryEntry = typeof glossary.$inferSelect;
export type NewGlossaryEntry = typeof glossary.$inferInsert;

/**
 * Find glossary entries that appear in the given text.
 */
export async function findMatchingGlossaryEntries(
  db: Database,
  text: string,
  targetLanguage: string,
): Promise<Array<{ sourceText: string; translatedText: string }>> {
  return db
    .select({
      sourceText: glossary.sourceText,
      translatedText: glossary.translatedText,
    })
    .from(glossary)
    .where(
      and(
        eq(glossary.targetLanguage, targetLanguage),
        sql`instr(${text}, ${glossary.sourceText}) > 0`,
      ),
    )
    .all();
}
