/**
 * Dashboard stats queries — admin-only, so they live here rather than in the
 * shared db package (DQX-54). The recheck domain itself stays in @hiroba/db
 * (collectRecheckEntries backs the workflow cron too); this module only
 * aggregates it.
 */

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import {
  collectRecheckEntries,
  newsItems,
  topics,
  translations,
  type Database,
} from '@hiroba/db';

export type ArticleTypeStats = {
  total: number;
  withBody: number;
  /** Items with a finished English content translation. */
  translated: number;
  recheckDue: number;
  recheckUpcoming: number;
  recheckRetired: number;
};

export type AdminStats = {
  news: ArticleTypeStats & { byCategory: Record<string, number> };
  topics: ArticleTypeStats;
};

async function getTypeCounts(
  db: Database,
  itemType: 'news' | 'topic',
): Promise<Pick<ArticleTypeStats, 'total' | 'withBody' | 'translated'>> {
  const table = itemType === 'news' ? newsItems : topics;
  const [totalResult, withBodyResult, translatedResult] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(table)
      .get(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(table)
      .where(isNotNull(table.blocksJa))
      .get(),
    db
      .select({ count: sql<number>`count(DISTINCT item_id)` })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, itemType),
          eq(translations.language, 'en'),
          eq(translations.field, 'content'),
          eq(translations.state, 'done'),
        ),
      )
      .get(),
  ]);
  return {
    total: totalResult?.count ?? 0,
    withBody: withBodyResult?.count ?? 0,
    translated: translatedResult?.count ?? 0,
  };
}

/**
 * Symmetric per-type stats for the admin dashboard, plus the news category
 * breakdown. Recheck numbers come from one pass over the recheck domain.
 */
export async function getStats(db: Database): Promise<AdminStats> {
  const now = Temporal.Now.instant();
  const [newsCounts, topicCounts, entries, categoryResults] = await Promise.all(
    [
      getTypeCounts(db, 'news'),
      getTypeCounts(db, 'topic'),
      collectRecheckEntries(db, now),
      db
        .select({ category: newsItems.category, count: sql<number>`count(*)` })
        .from(newsItems)
        .groupBy(newsItems.category)
        .all(),
    ],
  );

  const recheck = {
    news: { recheckDue: 0, recheckUpcoming: 0, recheckRetired: 0 },
    topic: { recheckDue: 0, recheckUpcoming: 0, recheckRetired: 0 },
  };
  for (const entry of entries) {
    // The dashboard tracks news + topics; playguide rechecks flow through the
    // queue but aren't broken out here (no playguide tile).
    const bucket = recheck[entry.itemType as 'news' | 'topic'];
    if (!bucket) continue;
    if (entry.nextCheckAt === null) bucket.recheckRetired++;
    else if (Temporal.Instant.compare(entry.nextCheckAt, now) <= 0)
      bucket.recheckDue++;
    else bucket.recheckUpcoming++;
  }

  const byCategory: Record<string, number> = {};
  for (const row of categoryResults) {
    byCategory[row.category] = row.count;
  }

  return {
    news: { ...newsCounts, ...recheck.news, byCategory },
    topics: { ...topicCounts, ...recheck.topic },
  };
}
