/**
 * Database operations for admin API routes.
 */

import { and, eq, sql } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import {
  deleteTranslation,
  getRecheckQueue,
  getStats,
  glossary,
  invalidateBody,
  invalidateTopicBody,
  listNewsAdmin,
  listTopicsAdmin,
  upsertListItems,
  upsertTopicListItems,
  type Database,
  type GlossaryEntry,
} from '@hiroba/db';
import {
  fetchTopicsListPage,
  listTopicsSources,
  scrapeNewsList,
} from '@hiroba/scraper';
import { CATEGORIES, type Category } from '@hiroba/shared';

// Re-export db functions
export {
  getStats,
  getRecheckQueue,
  invalidateBody,
  invalidateTopicBody,
  listNewsAdmin,
  listTopicsAdmin,
  deleteTranslation,
  upsertListItems,
};

/**
 * Scrape one batch of topic listing sources (the current page + backnumber
 * months, newest first), seeding Phase-1 metadata. Batched + cursor-driven so
 * a full backfill of the ~168 sources stays within a Worker's limits — the
 * admin client loops until `done`. Only seeds metadata; it does NOT trigger the
 * (Gemini-billed) body/translate pipeline.
 */
export async function scrapeTopicsBatch(
  db: Database,
  options: { cursor?: number; batch?: number } = {},
): Promise<{
  processed: number;
  newItems: number;
  totalScraped: number;
  cursor: number;
  nextCursor: number;
  total: number;
  done: boolean;
}> {
  const cursor = Math.max(0, options.cursor ?? 0);
  const batch = Math.max(1, options.batch ?? 12);

  const sources = await listTopicsSources();
  const slice = sources.slice(cursor, cursor + batch);

  let newItems = 0;
  let totalScraped = 0;
  for (const source of slice) {
    const items = await fetchTopicsListPage(source.url, source.fallback);
    totalScraped += items.length;
    const inserted = await upsertTopicListItems(db, items);
    newItems += inserted.length;
  }

  const nextCursor = cursor + slice.length;
  return {
    processed: slice.length,
    newItems,
    totalScraped,
    cursor,
    nextCursor,
    total: sources.length,
    done: nextCursor >= sources.length,
  };
}

/**
 * Trigger a scrape for all categories.
 */
export async function triggerScrape(
  db: Database,
  options: { full?: boolean; category?: Category },
): Promise<{
  results: Array<{
    category: Category;
    newItems: number;
    totalScraped: number;
  }>;
  totalNewItems: number;
  totalScraped: number;
}> {
  const categoriesToScrape = options.category ? [options.category] : CATEGORIES;
  const results: Array<{
    category: Category;
    newItems: number;
    totalScraped: number;
  }> = [];

  for (const category of categoriesToScrape) {
    let newItems = 0;
    let totalScraped = 0;

    for await (const items of scrapeNewsList(category)) {
      totalScraped += items.length;
      const inserted = await upsertListItems(db, items);
      newItems += inserted.length;

      if (!options.full && inserted.length < items.length * 0.5) {
        break;
      }
    }

    results.push({ category, newItems, totalScraped });
  }

  return {
    results,
    totalNewItems: results.reduce((sum, r) => sum + r.newItems, 0),
    totalScraped: results.reduce((sum, r) => sum + r.totalScraped, 0),
  };
}

/**
 * Get all glossary entries.
 */
export async function getGlossaryEntries(
  db: Database,
  lang?: string,
): Promise<GlossaryEntry[]> {
  const query = db.select().from(glossary).$dynamic();

  return lang
    ? await query.where(eq(glossary.targetLanguage, lang)).all()
    : await query.all();
}

/**
 * Import glossary from CSV content.
 */
export async function importGlossaryFromCsv(
  db: Database,
  csvContent: string,
  targetLanguage: string,
): Promise<number> {
  const lines = csvContent.split('\n').filter((line) => line.trim());
  const now = Temporal.Now.instant();

  let imported = 0;
  for (const line of lines) {
    const [sourceText, translatedText] = line.split(',').map((s) => s.trim());
    if (!sourceText || !translatedText) continue;

    await db
      .insert(glossary)
      .values({
        sourceText,
        targetLanguage,
        translatedText,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [glossary.sourceText, glossary.targetLanguage],
        set: {
          translatedText,
          updatedAt: now,
        },
      });

    imported++;
  }

  return imported;
}

/**
 * Import glossary from GitHub.
 */
export async function importGlossaryFromGitHub(
  db: Database,
): Promise<{ imported: number; source: string }> {
  const GLOSSARY_URL =
    'https://raw.githubusercontent.com/dqx-translation-project/dqx-custom-translations/main/csv/glossary.csv';

  const response = await fetch(GLOSSARY_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch glossary: ${response.status}`);
  }

  const csv = await response.text();
  const lines = csv.split('\n').filter((line) => line.trim());
  const now = Temporal.Now.instant();

  // Clear existing glossary
  await db.delete(glossary);

  // Insert in batches
  const BATCH_SIZE = 25;
  let imported = 0;

  for (let i = 0; i < lines.length; i += BATCH_SIZE) {
    const batch = lines.slice(i, i + BATCH_SIZE);
    const entries = batch
      .map((line) => {
        const [japanese, english] = line.split(',').map((s) => s.trim());
        if (!japanese || !english) return null;
        return {
          sourceText: japanese,
          targetLanguage: 'en',
          translatedText: english,
          updatedAt: now,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    if (entries.length > 0) {
      await db
        .insert(glossary)
        .values(entries)
        .onConflictDoUpdate({
          target: [glossary.sourceText, glossary.targetLanguage],
          set: {
            translatedText: sql`excluded.translated_text`,
            updatedAt: sql`excluded.updated_at`,
          },
        });

      imported += entries.length;
    }
  }

  return { imported, source: GLOSSARY_URL };
}

/**
 * Delete a glossary entry.
 */
export async function deleteGlossaryEntry(
  db: Database,
  sourceText: string,
  targetLanguage: string,
): Promise<boolean> {
  const result = await db
    .delete(glossary)
    .where(
      and(
        eq(glossary.sourceText, sourceText),
        eq(glossary.targetLanguage, targetLanguage),
      ),
    )
    .returning({ sourceText: glossary.sourceText });

  return result.length > 0;
}
