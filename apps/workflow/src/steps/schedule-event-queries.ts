/**
 * D1 queries owned by the つよさ予報 schedule scrape (see
 * build-schedule-events.ts for the build step and index.ts for the cron
 * consumers) — their only callers, so they live here rather than in
 * @hiroba/db (DQX-53).
 */

import { and, eq, gte, inArray, like, lt, or, sql } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import {
  chunked,
  events,
  translations,
  type Database,
  type NewEvent,
} from '@hiroba/db';

/**
 * Replace the scraped schedule events (sourceType='schedule') that the fresh
 * つよさ予報 scrape re-covers. The page only ever shows the near-future window,
 * so deletion is scoped per content key to that content's earliest new row
 * onward — rows that have scrolled off the page are kept as history.
 * Delete-then-insert (batched to stay under D1's bound-parameter cap); ids are
 * deterministic so a partial failure self-heals on the next run.
 */
export async function replaceScheduleEvents(
  db: Database,
  rows: NewEvent[],
): Promise<void> {
  // Each content's coverage window starts at its earliest scraped row. Content
  // key is the sourceId up to the '#' ("defense#https://…/12.png" → "defense").
  const windowStarts = new Map<string, Temporal.ZonedDateTime>();
  for (const row of rows) {
    if (!row.sourceId) continue;
    const content = row.sourceId.split('#')[0];
    const prev = windowStarts.get(content);
    if (!prev || Temporal.ZonedDateTime.compare(row.startTime, prev) < 0) {
      windowStarts.set(content, row.startTime);
    }
  }
  for (const [content, start] of windowStarts) {
    await db
      .delete(events)
      .where(
        and(
          eq(events.sourceType, 'schedule'),
          or(
            eq(events.sourceId, content),
            like(events.sourceId, `${content}#%`),
          ),
          gte(events.startTime, start),
        ),
      );
  }
  // 8 bound params per row; D1 caps a statement at 100, so 12 rows max.
  const ROWS_PER_INSERT = 12;
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const batch = rows.slice(i, i + ROWS_PER_INSERT);
    if (batch.length === 0) continue;
    await db.insert(events).values(batch).onConflictDoNothing();
  }
}

/**
 * Prune scraped schedule events (sourceType='schedule') whose occurrence ended
 * before `cutoff`, along with their title translations. Schedule rows accrete
 * daily forever (each occurrence is its own row), so a retention horizon keeps
 * the table bounded; article events are never pruned. Returns the number of
 * events deleted.
 */
export async function pruneScheduleEvents(
  db: Database,
  cutoff: Temporal.ZonedDateTime,
): Promise<number> {
  const stale = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.sourceType, 'schedule'),
        lt(
          sql`COALESCE(${events.endTime}, ${events.startTime})`,
          // Serialize with the column's own driver mapping (offset: 'never').
          cutoff.toString({ offset: 'never' }),
        ),
      ),
    )
    .all();
  if (stale.length === 0) return 0;

  const ids = stale.map((r) => r.id);
  await chunked(ids, async (slice) => {
    await db.delete(events).where(inArray(events.id, slice));
    await db
      .delete(translations)
      .where(
        and(
          eq(translations.itemType, 'event'),
          inArray(translations.itemId, slice),
        ),
      );
    return [];
  });
  return ids.length;
}
