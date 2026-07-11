/**
 * Glossary tables - translation term mappings.
 *
 * Two layers, read through one view:
 *
 *   glossary          — the upstream mirror. Wiped and rebuilt nightly from the
 *                       dqx-translation-project CSV (see refreshGlossary). Never
 *                       edit rows here by hand: the next refresh erases them.
 *   glossary_overrides — admin-managed terms. Never touched by the refresh, so
 *                       edits here survive. Takes precedence over the upstream
 *                       mirror for the same (source_text, target_language).
 *   glossary_effective — the view translation actually reads: overrides layered
 *                       on top of the upstream mirror, one row per key.
 *
 * Both physical tables use a composite primary key (sourceText, targetLanguage)
 * so a term can have a different translation per target language.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  integer,
  primaryKey,
  sqliteTable,
  sqliteView,
  text,
} from 'drizzle-orm/sqlite-core';
import { Temporal } from 'temporal-polyfill';

import type { Database } from '../client';
import { instant } from '../types/instant';

export const glossary = sqliteTable(
  'glossary',
  {
    // Composite key components
    sourceText: text('source_text').notNull(), // Japanese term
    targetLanguage: text('target_language').notNull(), // e.g., "en"

    // Translation
    translatedText: text('translated_text').notNull(),

    // Tracking
    updatedAt: instant('updated_at').notNull(), // epoch ms (Temporal.Instant)
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.sourceText, table.targetLanguage],
    }),
  }),
);

/**
 * Admin-managed overrides — same shape as {@link glossary}, but never cleared by
 * the nightly refresh. A row here shadows the upstream mirror for its key.
 */
export const glossaryOverrides = sqliteTable(
  'glossary_overrides',
  {
    sourceText: text('source_text').notNull(),
    targetLanguage: text('target_language').notNull(),
    translatedText: text('translated_text').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.sourceText, table.targetLanguage],
    }),
  }),
);

/**
 * The merged view: every override, plus the upstream rows no override shadows.
 * `isOverride` lets the admin badge which layer a row came from. Created by
 * migration 0016 — `.existing()` tells drizzle the DDL lives there.
 */
export const glossaryEffective = sqliteView('glossary_effective', {
  sourceText: text('source_text').notNull(),
  targetLanguage: text('target_language').notNull(),
  translatedText: text('translated_text').notNull(),
  updatedAt: instant('updated_at').notNull(),
  isOverride: integer('is_override', { mode: 'boolean' }).notNull(),
}).existing();

// Type exports
export type GlossaryEntry = typeof glossary.$inferSelect;
export type NewGlossaryEntry = typeof glossary.$inferInsert;
export type GlossaryOverride = typeof glossaryOverrides.$inferSelect;
export type EffectiveGlossaryEntry = typeof glossaryEffective.$inferSelect;

/**
 * Find glossary entries that appear in the given text — read through the
 * effective view so admin overrides win over the upstream mirror.
 */
export async function findMatchingGlossaryEntries(
  db: Database,
  text: string,
  targetLanguage: string,
): Promise<Array<{ sourceText: string; translatedText: string }>> {
  return db
    .select({
      sourceText: glossaryEffective.sourceText,
      translatedText: glossaryEffective.translatedText,
    })
    .from(glossaryEffective)
    .where(
      and(
        eq(glossaryEffective.targetLanguage, targetLanguage),
        sql`instr(${text}, ${glossaryEffective.sourceText}) > 0`,
      ),
    )
    .all();
}

/**
 * The effective glossary for the admin listing — overrides layered on the
 * upstream mirror, each row flagged with which layer it came from.
 */
export async function listEffectiveGlossary(
  db: Database,
  targetLanguage?: string,
): Promise<EffectiveGlossaryEntry[]> {
  const query = db.select().from(glossaryEffective).$dynamic();
  return targetLanguage
    ? query.where(eq(glossaryEffective.targetLanguage, targetLanguage)).all()
    : query.all();
}

/** Create or update an admin override (survives the nightly refresh). */
export async function upsertGlossaryOverride(
  db: Database,
  params: {
    sourceText: string;
    targetLanguage: string;
    translatedText: string;
  },
): Promise<void> {
  const now = Temporal.Now.instant();
  await db
    .insert(glossaryOverrides)
    .values({ ...params, updatedAt: now })
    .onConflictDoUpdate({
      target: [glossaryOverrides.sourceText, glossaryOverrides.targetLanguage],
      set: {
        translatedText: params.translatedText,
        updatedAt: now,
      },
    });
}

/**
 * Remove an admin override. The upstream mirror row (if any) resurfaces in the
 * effective view. Returns false when no override existed.
 */
export async function deleteGlossaryOverride(
  db: Database,
  sourceText: string,
  targetLanguage: string,
): Promise<boolean> {
  const result = await db
    .delete(glossaryOverrides)
    .where(
      and(
        eq(glossaryOverrides.sourceText, sourceText),
        eq(glossaryOverrides.targetLanguage, targetLanguage),
      ),
    )
    .returning({ sourceText: glossaryOverrides.sourceText });
  return result.length > 0;
}
