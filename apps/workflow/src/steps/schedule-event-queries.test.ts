import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  events,
  translations,
  upsertItemTranslation,
  type NewEvent,
} from '@hiroba/db';
import { createTestDb, type TestDb } from '@hiroba/db/test-db';

import {
  pruneScheduleEvents,
  replaceScheduleEvents,
} from './schedule-event-queries';

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

describe('replaceScheduleEvents', () => {
  const zdt = (s: string) => Temporal.ZonedDateTime.from(`${s}:00[Asia/Tokyo]`);

  /** A schedule event row; icon sections encode the icon URL in sourceId. */
  function schedEvent(
    id: string,
    content: string,
    start: string,
    end: string,
    icon?: string,
  ): NewEvent {
    return {
      id,
      type: 'span',
      titleJa: `event-${id}`,
      startTime: zdt(start),
      endTime: zdt(end),
      sourceType: 'schedule',
      sourceId: icon ? `${content}#${icon}` : content,
      createdAt: BASE,
    };
  }

  it('replaces only the window each content re-covers, keeping older history', async () => {
    await ctx.db.insert(events).values([
      // Scrolled off the page — history that must survive.
      schedEvent(
        'old-def',
        'defense',
        '2026-07-10T06:00',
        '2026-07-10T07:00',
        'https://x/1.png',
      ),
      schedEvent(
        'old-boot',
        'bootcamp',
        '2026-06-28T06:00',
        '2026-07-05T06:00',
      ),
      // Inside the new windows — stale, replaced by the fresh scrape.
      schedEvent(
        'stale-def',
        'defense',
        '2026-07-11T06:00',
        '2026-07-11T07:00',
        'https://x/2.png',
      ),
      schedEvent(
        'stale-boot',
        'bootcamp',
        '2026-07-05T06:00',
        '2026-07-12T06:00',
      ),
      // Content absent from the new scrape — untouched even inside the window.
      schedEvent(
        'old-metal',
        'metal',
        '2026-07-11T06:00',
        '2026-07-11T06:30',
        'https://x/m.png',
      ),
      // Article events are never schedule-managed.
      {
        id: 'news-ev',
        type: 'span',
        titleJa: 'ニュース',
        startTime: zdt('2026-07-11T06:00'),
        endTime: zdt('2026-07-11T07:00'),
        sourceType: 'news',
        sourceId: 'abc',
        createdAt: BASE,
      },
    ]);

    await replaceScheduleEvents(ctx.db, [
      schedEvent(
        'new-def-1',
        'defense',
        '2026-07-11T06:00',
        '2026-07-11T07:00',
        'https://x/3.png',
      ),
      schedEvent(
        'new-def-2',
        'defense',
        '2026-07-11T07:00',
        '2026-07-11T08:00',
        'https://x/4.png',
      ),
      schedEvent(
        'new-boot',
        'bootcamp',
        '2026-07-05T06:00',
        '2026-07-12T06:00',
      ),
    ]);

    const ids = (await ctx.db.select().from(events).all())
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual(
      [
        'news-ev',
        'old-def',
        'old-boot',
        'old-metal',
        'new-def-1',
        'new-def-2',
        'new-boot',
      ].sort(),
    );
  });
});

describe('pruneScheduleEvents', () => {
  const zdt = (s: string) => Temporal.ZonedDateTime.from(`${s}:00[Asia/Tokyo]`);

  it('deletes schedule events ended before the cutoff, with their translations', async () => {
    await ctx.db.insert(events).values([
      // Ended long before the cutoff — pruned.
      {
        id: 'sched-old',
        type: 'span',
        titleJa: '防衛軍',
        startTime: zdt('2026-01-10T06:00'),
        endTime: zdt('2026-01-10T07:00'),
        sourceType: 'schedule',
        sourceId: 'defense#https://x/1.png',
        createdAt: BASE,
      },
      // End-less allDay row falls back to startTime — pruned.
      {
        id: 'sched-old-allday',
        type: 'allDay',
        titleJa: '深淵の咎人たち',
        startTime: zdt('2026-01-10T00:00'),
        endTime: null,
        sourceType: 'schedule',
        sourceId: 'abyss#https://x/2.png',
        createdAt: BASE,
      },
      // Ended after the cutoff — kept.
      {
        id: 'sched-recent',
        type: 'span',
        titleJa: 'メタルーキー',
        startTime: zdt('2026-06-01T06:00'),
        endTime: zdt('2026-06-01T06:30'),
        sourceType: 'schedule',
        sourceId: 'metal#https://x/3.png',
        createdAt: BASE,
      },
      // Old but not schedule-sourced — kept.
      {
        id: 'news-old',
        type: 'span',
        titleJa: 'ニュース',
        startTime: zdt('2026-01-10T06:00'),
        endTime: zdt('2026-01-10T07:00'),
        sourceType: 'news',
        sourceId: 'abc',
        createdAt: BASE,
      },
    ]);
    await upsertItemTranslation(ctx.db, {
      itemType: 'event',
      itemId: 'sched-old',
      language: 'en',
      field: 'title',
      value: 'Defense Force',
      model: 'test',
    });
    await upsertItemTranslation(ctx.db, {
      itemType: 'event',
      itemId: 'sched-recent',
      language: 'en',
      field: 'title',
      value: 'Metal Rookie',
      model: 'test',
    });

    const pruned = await pruneScheduleEvents(ctx.db, zdt('2026-04-11T00:00'));

    expect(pruned).toBe(2);
    const ids = (await ctx.db.select().from(events).all())
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual(['news-old', 'sched-recent']);
    const trans = await ctx.db.select().from(translations).all();
    expect(trans.map((t) => t.itemId)).toEqual(['sched-recent']);
  });
});
