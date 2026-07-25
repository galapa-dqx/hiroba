import { asc, eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { materializeResetEvents, pruneResetEvents } from './reset-events';
import { events } from './schema/events';
import { languages } from './schema/languages';
import { resetMilestones } from './schema/reset-milestones';
import { translations } from './schema/translations';
import { createTestDb, type TestDb } from './test-db';

/**
 * DB-path coverage for the materialization helpers moved into reset-events.ts
 * (DQX-51). The pure builder is exercised in reset-events.test.ts; here we pin
 * that events + their per-language title rows land, replace on re-materialize,
 * and clear together on prune — the atomic delete-both-tables batch.
 */

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

const NOW = Temporal.Instant.from('2026-02-01T00:00:00Z');
const ZONE = 'Asia/Tokyo';
const ics = (dtstart: string, rule: string) =>
  `DTSTART;TZID=${ZONE}:${dtstart}\nRRULE:${rule}`;

/** Seed the daily reset and enable en + fr, so each mark gets two title rows. */
async function seed() {
  await ctx.db.insert(languages).values([
    {
      code: 'en',
      label: 'English',
      nativeLabel: 'English',
      enabled: true,
      updatedAt: NOW,
    },
    {
      code: 'fr',
      label: 'French',
      nativeLabel: 'Français',
      enabled: true,
      updatedAt: NOW,
    },
  ]);
  await ctx.db.insert(resetMilestones).values({
    id: 'daily',
    titleJa: 'デイリー',
    titles: { en: 'Daily reset', fr: 'Réinitialisation quotidienne' },
    rrule: ics('20200101T060000', 'FREQ=DAILY'),
    enabled: true,
    sortOrder: 0,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

const resetEvents = () =>
  ctx.db
    .select()
    .from(events)
    .where(eq(events.sourceType, 'reset'))
    .orderBy(asc(events.startTime))
    .all();

const eventTitles = () =>
  ctx.db
    .select()
    .from(translations)
    .where(eq(translations.itemType, 'event'))
    .all();

describe('materializeResetEvents (DB path)', () => {
  it('writes one mark per day in the horizon, each with per-language titles', async () => {
    await seed();

    const { marks } = await materializeResetEvents(ctx.db, {
      now: NOW,
      horizonDays: 7,
    });

    // from = midnight JST today; the +7d `to` bound excludes that day's 06:00
    // mark, so the daily reset fires on Feb 1–7 → 7 marks.
    expect(marks).toBe(7);
    const rows = await resetEvents();
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.type === 'mark' && r.endTime === null)).toBe(
      true,
    );

    // Two title rows (en + fr) per mark, state=done with the reset source tag.
    const titles = await eventTitles();
    expect(titles).toHaveLength(14);
    expect(titles.every((t) => t.state === 'done' && t.model === 'reset')).toBe(
      true,
    );
    const first = rows[0];
    const forFirst = titles.filter((t) => t.itemId === first.id);
    expect(new Map(forFirst.map((t) => [t.language, t.value]))).toEqual(
      new Map([
        ['en', 'Daily reset'],
        ['fr', 'Réinitialisation quotidienne'],
      ]),
    );
  });

  it('replaces the forward window on re-materialize without doubling rows', async () => {
    await seed();
    await materializeResetEvents(ctx.db, { now: NOW, horizonDays: 7 });

    // Disable the def, then re-materialize: the window is cleared and nothing
    // new is written — no orphaned events or title rows survive.
    await ctx.db
      .update(resetMilestones)
      .set({ enabled: false })
      .where(eq(resetMilestones.id, 'daily'));
    const { marks } = await materializeResetEvents(ctx.db, {
      now: NOW,
      horizonDays: 7,
    });

    expect(marks).toBe(0);
    expect(await resetEvents()).toHaveLength(0);
    expect(await eventTitles()).toHaveLength(0);
  });
});

describe('pruneResetEvents (DB path)', () => {
  it('deletes passed marks and their titles together, keeping future ones', async () => {
    await seed();
    await materializeResetEvents(ctx.db, { now: NOW, horizonDays: 7 });

    const before = await resetEvents();
    // Cutoff three days in: the marks before it (and their titles) go; the rest
    // stay, with their title rows intact.
    const cutoff = before[3].startTime;
    const deleted = await pruneResetEvents(ctx.db, cutoff);

    expect(deleted).toBe(3);
    const remaining = await resetEvents();
    expect(remaining).toHaveLength(before.length - 3);
    const survivingIds = new Set(remaining.map((r) => r.id));

    const titles = await eventTitles();
    // Every surviving title belongs to a surviving event; none stranded.
    expect(titles.every((t) => survivingIds.has(t.itemId))).toBe(true);
    expect(titles).toHaveLength(remaining.length * 2);
  });

  it('is a no-op when nothing has passed the cutoff', async () => {
    await seed();
    await materializeResetEvents(ctx.db, { now: NOW, horizonDays: 7 });
    const cutoff = Temporal.ZonedDateTime.from(`2026-01-01T00:00:00[${ZONE}]`);

    expect(await pruneResetEvents(ctx.db, cutoff)).toBe(0);
    expect(await resetEvents()).toHaveLength(7);
  });
});
