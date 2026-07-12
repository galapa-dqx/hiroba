import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { buildResetEvents } from './reset-events';
import type { ResetMilestone } from './schema/reset-milestones';

const NOW = Temporal.Instant.from('2026-01-01T00:00:00Z');
const ZONE = 'Asia/Tokyo';

/** DTSTART anchor + RRULE → the ICS string a reset row stores. */
const ics = (dtstart: string, rule: string) =>
  `DTSTART;TZID=${ZONE}:${dtstart}\nRRULE:${rule}`;

function def(
  partial: Partial<ResetMilestone> & Pick<ResetMilestone, 'id'>,
): ResetMilestone {
  return {
    titleJa: partial.id,
    titles: { en: partial.id, ja: partial.id },
    rrule: ics('20200101T060000', 'FREQ=DAILY'),
    enabled: true,
    sortOrder: 0,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

// The canonical DQX resets (see migration 0020). 2026-02-01 is a Sunday *and*
// the 1st, so on that day daily + weekly + semi(1/15) + monthly all coincide.
const DEFS: ResetMilestone[] = [
  def({
    id: 'daily',
    titleJa: 'デイリー',
    titles: { en: 'Daily reset', ja: 'デイリー' },
    rrule: ics('20200101T060000', 'FREQ=DAILY'),
    sortOrder: 0,
  }),
  def({
    id: 'weekly-sun',
    titleJa: 'ウィークリー',
    titles: { en: 'Weekly reset', ja: 'ウィークリー' },
    rrule: ics('20200105T060000', 'FREQ=WEEKLY;BYDAY=SU'),
    sortOrder: 1,
  }),
  def({
    id: 'semimonthly-1-15',
    titleJa: '半月(1・15)',
    titles: { en: 'Semi-monthly reset (1st/15th)', ja: '半月(1・15)' },
    rrule: ics('20200101T060000', 'FREQ=MONTHLY;BYMONTHDAY=1,15'),
    sortOrder: 2,
  }),
  def({
    id: 'semimonthly-10-25',
    titleJa: '半月(10・25)',
    titles: { en: 'Semi-monthly reset (10th/25th)', ja: '半月(10・25)' },
    rrule: ics('20200110T060000', 'FREQ=MONTHLY;BYMONTHDAY=10,25'),
    sortOrder: 3,
  }),
  def({
    id: 'monthly-1',
    titleJa: 'マンスリー',
    titles: { en: 'Monthly reset', ja: 'マンスリー' },
    rrule: ics('20200101T060000', 'FREQ=MONTHLY;BYMONTHDAY=1'),
    sortOrder: 4,
  }),
];

// A full February-2026 JST window.
const FROM = Temporal.ZonedDateTime.from(`2026-02-01T00:00:00[${ZONE}]`);
const TO = Temporal.ZonedDateTime.from(`2026-03-01T00:00:00[${ZONE}]`);

/** The single merged mark landing on `date` (YYYY-MM-DD), or undefined. */
function markOn(result: ReturnType<typeof buildResetEvents>, date: string) {
  return result.events.find((e) =>
    e.startTime.toString().startsWith(`${date}T06:00:00`),
  );
}

describe('buildResetEvents', () => {
  const result = buildResetEvents(DEFS, FROM, TO, ['en'], NOW);

  it('emits one mark per distinct occurrence day (daily covers the month)', () => {
    // Every day in Feb 2026 (28 days) has at least the daily reset → 28 marks,
    // one per instant (coincident resets merge, they never add rows).
    expect(result.events).toHaveLength(28);
    for (const e of result.events) {
      expect(e.type).toBe('mark');
      expect(e.endTime).toBeNull();
      expect(e.sourceType).toBe('reset');
      expect(e.sourceId).toBeNull();
    }
  });

  it('fires all coincident resets on Feb 1 (Sunday + 1st) as one merged mark', () => {
    const mark = markOn(result, '2026-02-01');
    expect(mark).toBeDefined();
    // Joined in sortOrder: daily, weekly, semi(1/15), monthly — semi(10/25) is
    // *not* firing on the 1st.
    expect(result.titles.get(mark!.id)!.en).toBe(
      'Daily reset · Weekly reset · Semi-monthly reset (1st/15th) · Monthly reset',
    );
    expect(mark!.startTime.toString()).toContain('2026-02-01T06:00:00');
  });

  it('merges daily + weekly on a plain Sunday (Feb 8)', () => {
    const mark = markOn(result, '2026-02-08');
    expect(result.titles.get(mark!.id)!.en).toBe('Daily reset · Weekly reset');
  });

  it('merges daily + semi(10/25) on the 10th', () => {
    const mark = markOn(result, '2026-02-10');
    expect(result.titles.get(mark!.id)!.en).toBe(
      'Daily reset · Semi-monthly reset (10th/25th)',
    );
  });

  it('is daily-only on an ordinary weekday (Feb 2, Monday)', () => {
    const mark = markOn(result, '2026-02-02');
    expect(result.titles.get(mark!.id)!.en).toBe('Daily reset');
  });

  it('excludes disabled definitions', () => {
    const noWeekly = DEFS.map((d) =>
      d.id === 'weekly-sun' ? { ...d, enabled: false } : d,
    );
    const r = buildResetEvents(noWeekly, FROM, TO, ['en'], NOW);
    expect(r.titles.get(markOn(r, '2026-02-08')!.id)!.en).toBe('Daily reset');
    // Feb 1 no longer includes the weekly reset.
    expect(r.titles.get(markOn(r, '2026-02-01')!.id)!.en).toBe(
      'Daily reset · Semi-monthly reset (1st/15th) · Monthly reset',
    );
  });

  it('falls back language → en → Japanese for each name', () => {
    const custom = [
      def({
        id: 'a',
        titleJa: 'エーのリセット',
        titles: { ja: 'エーのリセット' }, // no en
        rrule: ics('20200101T060000', 'FREQ=DAILY'),
        sortOrder: 0,
      }),
      def({
        id: 'b',
        titleJa: 'ビー',
        titles: { en: 'B reset', ja: 'ビー' }, // no fr
        rrule: ics('20200101T060000', 'FREQ=DAILY'),
        sortOrder: 1,
      }),
    ];
    const r = buildResetEvents(custom, FROM, TO, ['fr'], NOW);
    const mark = markOn(r, '2026-02-02')!;
    // a: no fr, no en → Japanese; b: no fr → en.
    expect(r.titles.get(mark.id)!.fr).toBe('エーのリセット · B reset');
    // titleJa is always the Japanese join.
    expect(mark.titleJa).toBe('エーのリセット・ビー');
  });
});
