/**
 * Languages table - the admin-managed whitelist of translation target
 * languages.
 *
 * Every language-parameterized part of the system hangs off this table: the
 * workflow pipeline translates into each enabled language, the web app serves
 * a /<code>/ route tree per enabled language, and the admin manages the list.
 * Japanese is the source language, so it never appears here.
 *
 *   label        — English name ("French"), interpolated into LLM prompts
 *                  ("translate to natural French")
 *   native_label — endonym ("Français"), shown in the web language selector
 */

import { asc, eq } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Temporal } from 'temporal-polyfill';

import type { Database } from '../client';
import { instant } from '../types/instant';

export const languages = sqliteTable('languages', {
  /** BCP-47-style code, e.g. "en", "fr", "zh-TW" — also the URL path prefix. */
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  nativeLabel: text('native_label').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  updatedAt: instant('updated_at').notNull(),
});

// Type exports
export type Language = typeof languages.$inferSelect;
export type NewLanguage = typeof languages.$inferInsert;

/**
 * The built-in fallback when the table is empty (fresh database, tests) —
 * keeps every consumer working before the whitelist is first configured.
 */
export const FALLBACK_LANGUAGE = {
  code: 'en',
  label: 'English',
  nativeLabel: 'English',
} as const;

/** All languages, enabled or not (the admin listing). */
export async function listLanguages(db: Database): Promise<Language[]> {
  return db.select().from(languages).orderBy(asc(languages.code)).all();
}

/**
 * The enabled languages, never empty: falls back to English when none are
 * enabled so the pipeline and the web app always have a target to work with.
 */
export async function getEnabledLanguages(
  db: Database,
): Promise<Array<Pick<Language, 'code' | 'label' | 'nativeLabel'>>> {
  const rows = await db
    .select({
      code: languages.code,
      label: languages.label,
      nativeLabel: languages.nativeLabel,
    })
    .from(languages)
    .where(eq(languages.enabled, true))
    .orderBy(asc(languages.code))
    .all();
  return rows.length > 0 ? rows : [{ ...FALLBACK_LANGUAGE }];
}

/** Create or update a language (admin whitelist page). */
export async function upsertLanguage(
  db: Database,
  params: {
    code: string;
    label: string;
    nativeLabel: string;
    enabled: boolean;
  },
): Promise<void> {
  const now = Temporal.Now.instant();
  await db
    .insert(languages)
    .values({ ...params, updatedAt: now })
    .onConflictDoUpdate({
      target: languages.code,
      set: {
        label: params.label,
        nativeLabel: params.nativeLabel,
        enabled: params.enabled,
        updatedAt: now,
      },
    });
}

/** Flip a language's enabled flag. Returns false for an unknown code. */
export async function setLanguageEnabled(
  db: Database,
  code: string,
  enabled: boolean,
): Promise<boolean> {
  const result = await db
    .update(languages)
    .set({ enabled, updatedAt: Temporal.Now.instant() })
    .where(eq(languages.code, code))
    .returning({ code: languages.code });
  return result.length > 0;
}

/** Remove a language from the whitelist. Returns false for an unknown code. */
export async function deleteLanguage(
  db: Database,
  code: string,
): Promise<boolean> {
  const result = await db
    .delete(languages)
    .where(eq(languages.code, code))
    .returning({ code: languages.code });
  return result.length > 0;
}

/**
 * The English name of a language, for LLM prompt interpolation ("translate to
 * natural French"). Unknown codes fall back to the code itself — the prompt
 * degrades ("translate to natural fr") rather than the pipeline failing.
 */
export async function getLanguageLabel(
  db: Database,
  code: string,
): Promise<string> {
  if (code === FALLBACK_LANGUAGE.code) return FALLBACK_LANGUAGE.label;
  const row = await db
    .select({ label: languages.label })
    .from(languages)
    .where(eq(languages.code, code))
    .get();
  return row?.label ?? code;
}
