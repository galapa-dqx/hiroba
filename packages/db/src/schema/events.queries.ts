/**
 * Event read queries, co-located with the events schema (DQX-51). Both reads
 * merge each row's localized title through the `title` relation (see
 * ../relations.ts) and flatten it with withLocalizedTitle.
 */

import { type Temporal } from 'temporal-polyfill';

import type { Database } from '../client';
import { withLocalizedTitle } from '../relations';
import type { Event } from './events';

/** An extracted event with its English title translation merged in (null when
 * the title hasn't been translated yet — the caller falls back to titleJa). */
export type EventWithTitle = Event & { localizedTitle: string | null };

/**
 * Fetch the events extracted from a single source article (news item or topic),
 * ordered chronologically by start time, each merged with its English title
 * translation (item_type='event') when one exists. Powers the "events in this
 * article" rail on the article pages.
 */
export async function getEventsForSource(
  db: Database,
  sourceType: 'news' | 'topic',
  sourceId: string,
  language: string = 'en',
): Promise<EventWithTitle[]> {
  // Via the provenance relation, not events.source_id: a campaign mentioned
  // here but whose *primary* source is a different article (its own dedicated
  // page) must still appear in this article's rail.
  const rows = await db.query.events.findMany({
    where: { sources: { sourceType, sourceId } },
    with: { title: { where: { language }, columns: { value: true } } },
    orderBy: { startTime: 'asc' },
  });
  return rows.map(withLocalizedTitle);
}

/**
 * Fetch every event overlapping a single JST calendar day, ordered by start
 * time, each merged with its title translation. Powers the day-scoped agenda
 * timeline page. An event overlaps the day `[dayStart, dayEnd)` when it starts
 * before the day ends and its effective end (its own end, or its start for the
 * end-less allDay/mark rows) lands on or after the day starts.
 *
 * Bounds are compared as the stored RFC9557 strings: all rows share the
 * `[Asia/Tokyo]` zone and a fixed format, so lexicographic order matches
 * chronological order.
 */
export async function getEventsForDay(
  db: Database,
  jstDate: Temporal.PlainDate,
  language: string = 'en',
): Promise<EventWithTitle[]> {
  const dayStart = jstDate.toZonedDateTime('Asia/Tokyo');
  const dayEnd = dayStart.add({ days: 1 });
  const rows = await db.query.events.findMany({
    where: {
      startTime: { lt: dayEnd },
      OR: [
        // Starts within the day (covers point-in-time events at 00:00)…
        { startTime: { gte: dayStart } },
        // …or began earlier and runs strictly past 00:00. An event ending
        // exactly at 00:00 belongs to the previous day, so it no longer shows
        // as a zero-height sliver pinned to the top of this one.
        { endTime: { gt: dayStart } },
      ],
    },
    with: { title: { where: { language }, columns: { value: true } } },
    orderBy: { startTime: 'asc' },
  });
  return rows.map(withLocalizedTitle);
}
