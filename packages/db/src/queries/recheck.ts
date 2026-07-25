/**
 * Recheck scheduling (news + topics + playguides). Kept in the db package
 * because getRecheckQueue feeds both the admin recheck page and workflow's
 * getDueRechecks. collectRecheckEntries is exported for the admin dashboard's
 * getStats (apps/admin, DQX-54), which buckets the whole domain per item type.
 */

import { eq, isNotNull } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import type { Block } from '@hiroba/richtext';
import { getNextCheckTime } from '@hiroba/shared';

import type { Database } from '../client';
import { newsItems } from '../schema/news-items';
import { playguides } from '../schema/playguides';
import { topics } from '../schema/topics';
import { articleTable, type ArticleType } from './articles';

/** One article in the recheck domain (its body has been fetched at least once). */
export type RecheckEntry = {
  itemType: ArticleType;
  id: string;
  titleJa: string;
  category: string | null;
  publishedAt: Temporal.Instant;
  /** Last observed content change (publication when never seen to change). */
  lastChangedAt: Temporal.Instant;
  /** Last time the source page was polled. */
  bodyCheckedAt: Temporal.Instant;
  /** Next due poll — null once retired (quiet past the retirement horizon). */
  nextCheckAt: Temporal.Instant | null;
};

/** Every fetched article of every type, with its recheck schedule computed.
 *  Exported for the admin dashboard's getStats (apps/admin, DQX-54), which
 *  buckets the whole domain per item type — a shape getRecheckQueue's
 *  due/upcoming/retired split doesn't preserve. */
export async function collectRecheckEntries(
  db: Database,
  now: Temporal.Instant,
): Promise<RecheckEntry[]> {
  const [news, topicRows, playguideRows] = await Promise.all([
    db
      .select({
        id: newsItems.id,
        titleJa: newsItems.titleJa,
        category: newsItems.category,
        publishedAt: newsItems.publishedAt,
        bodyFetchedAt: newsItems.bodyFetchedAt,
        bodyCheckedAt: newsItems.bodyCheckedAt,
        bodyChangedAt: newsItems.bodyChangedAt,
      })
      .from(newsItems)
      .where(isNotNull(newsItems.bodyFetchedAt))
      .all(),
    db
      .select({
        id: topics.id,
        titleJa: topics.titleJa,
        category: topics.category,
        publishedAt: topics.publishedAt,
        bodyFetchedAt: topics.bodyFetchedAt,
        bodyCheckedAt: topics.bodyCheckedAt,
        bodyChangedAt: topics.bodyChangedAt,
      })
      .from(topics)
      .where(isNotNull(topics.bodyFetchedAt))
      .all(),
    db
      .select({
        id: playguides.id,
        titleJa: playguides.titleJa,
        publishedAt: playguides.publishedAt,
        bodyFetchedAt: playguides.bodyFetchedAt,
        bodyCheckedAt: playguides.bodyCheckedAt,
        bodyChangedAt: playguides.bodyChangedAt,
      })
      .from(playguides)
      .where(isNotNull(playguides.bodyFetchedAt))
      .all(),
  ]);

  const toEntry = (
    itemType: ArticleType,
    row: {
      id: string;
      titleJa: string;
      category?: string | null;
      // Playguides have no publish date; the change anchor falls back to the
      // fetch time (which is non-null for anything in the recheck domain).
      publishedAt: Temporal.Instant | null;
      bodyFetchedAt: Temporal.Instant | null;
      bodyCheckedAt: Temporal.Instant | null;
      bodyChangedAt: Temporal.Instant | null;
    },
  ): RecheckEntry => {
    const anchor = row.publishedAt ?? row.bodyFetchedAt!;
    const lastChangedAt = row.bodyChangedAt ?? anchor;
    const bodyCheckedAt = row.bodyCheckedAt ?? row.bodyFetchedAt!;
    return {
      itemType,
      id: row.id,
      titleJa: row.titleJa,
      category: row.category ?? null,
      publishedAt: anchor,
      lastChangedAt,
      bodyCheckedAt,
      nextCheckAt: getNextCheckTime(lastChangedAt, bodyCheckedAt, now),
    };
  };

  return [
    ...news.map((row) => toEntry('news', row)),
    ...topicRows.map((row) => toEntry('topic', row)),
    ...playguideRows.map((row) => toEntry('playguide', row)),
  ];
}

export type RecheckQueue = {
  /** Due now, most overdue first. */
  due: RecheckEntry[];
  /** Scheduled in the future, soonest first. */
  upcoming: RecheckEntry[];
  /** Articles quiet past the retirement horizon — no longer checked. */
  retired: number;
};

/**
 * The recheck queue for the admin page: due items, the next scheduled checks,
 * and how many articles have been retired from checking.
 */
export async function getRecheckQueue(
  db: Database,
  options: { dueLimit?: number; upcomingLimit?: number } = {},
): Promise<RecheckQueue> {
  const dueLimit = options.dueLimit ?? 100;
  const upcomingLimit = options.upcomingLimit ?? 25;
  const now = Temporal.Now.instant();

  const entries = await collectRecheckEntries(db, now);
  const due: RecheckEntry[] = [];
  const upcoming: RecheckEntry[] = [];
  let retired = 0;

  for (const entry of entries) {
    if (entry.nextCheckAt === null) retired++;
    else if (Temporal.Instant.compare(entry.nextCheckAt, now) <= 0)
      due.push(entry);
    else upcoming.push(entry);
  }

  const byNextCheck = (a: RecheckEntry, b: RecheckEntry) =>
    Temporal.Instant.compare(a.nextCheckAt!, b.nextCheckAt!);
  due.sort(byNextCheck);
  upcoming.sort(byNextCheck);

  return {
    due: due.slice(0, dueLimit),
    upcoming: upcoming.slice(0, upcomingLimit),
    retired,
  };
}

/**
 * Due rechecks for the cron consumer, most overdue first, with the stored
 * block tree loaded for change detection.
 */
export async function getDueRechecks(
  db: Database,
  limit: number,
): Promise<Array<RecheckEntry & { blocksJa: Block[] | null }>> {
  const { due } = await getRecheckQueue(db, {
    dueLimit: limit,
    upcomingLimit: 0,
  });

  const out: Array<RecheckEntry & { blocksJa: Block[] | null }> = [];
  for (const entry of due) {
    const table = articleTable(entry.itemType);
    const row = await db
      .select({ blocksJa: table.blocksJa })
      .from(table)
      .where(eq(table.id, entry.id))
      .get();
    out.push({ ...entry, blocksJa: row?.blocksJa ?? null });
  }
  return out;
}

/** Record that a recheck poll found no change. */
export async function setBodyChecked(
  db: Database,
  itemType: ArticleType,
  id: string,
  at: Temporal.Instant = Temporal.Now.instant(),
): Promise<void> {
  const table = articleTable(itemType);
  await db.update(table).set({ bodyCheckedAt: at }).where(eq(table.id, id));
}
