import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test-db';
import { events, type NewEvent } from './events';
import { getEventsForDay } from './events.queries';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.dispose();
});
beforeEach(async () => {
  await ctx.reset();
});

const BASE = Temporal.Instant.from('2026-01-01T00:00:00Z');

describe('getEventsForDay day-boundary overlap', () => {
  const zdt = (s: string) => Temporal.ZonedDateTime.from(`${s}:00[Asia/Tokyo]`);

  /** Minimal event row; a null `end` marks a point-in-time event. */
  function ev(id: string, start: string, end: string | null): NewEvent {
    return {
      id,
      type: end ? 'span' : 'mark',
      titleJa: id,
      startTime: zdt(start),
      endTime: end ? zdt(end) : null,
      sourceType: 'schedule',
      sourceId: 'metal',
      createdAt: BASE,
    };
  }

  const idsFor = async (date: string) =>
    (await getEventsForDay(ctx.db, Temporal.PlainDate.from(date)))
      .map((e) => e.id)
      .sort();

  it('assigns an event ending exactly at 00:00 to the previous day, not the next', async () => {
    await ctx.db.insert(events).values([
      // Ends exactly at the July 13 boundary — belongs to July 12 only. The bug:
      // it rendered as a zero-height sliver pinned to the top of July 13.
      ev('ends-at-midnight', '2026-07-12T23:30', '2026-07-13T00:00'),
      // Starts exactly at 00:00 — belongs to July 13 only.
      ev('starts-at-midnight', '2026-07-13T00:00', '2026-07-13T01:00'),
      // Fully inside July 13.
      ev('within-day', '2026-07-13T10:00', '2026-07-13T10:30'),
      // Straddles the boundary — belongs to both days.
      ev('spans-midnight', '2026-07-12T23:00', '2026-07-13T01:00'),
      // Point-in-time event at exactly 00:00 — belongs to July 13.
      ev('point-at-midnight', '2026-07-13T00:00', null),
    ]);

    expect(await idsFor('2026-07-13')).toEqual([
      'point-at-midnight',
      'spans-midnight',
      'starts-at-midnight',
      'within-day',
    ]);
    expect(await idsFor('2026-07-12')).toEqual([
      'ends-at-midnight',
      'spans-midnight',
    ]);
  });
});
