import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import type { EventWithTitle } from '@hiroba/db';

import { buildDayAgenda } from './day-agenda';

const DAY = Temporal.PlainDate.from('2026-07-09');

/** Build a minimal EventWithTitle; only type/startTime/endTime drive layout. */
function ev(
  type: EventWithTitle['type'],
  start: string,
  end: string | null = null,
): EventWithTitle {
  return {
    id: `${type}-${start}`,
    type,
    titleJa: 'テスト',
    titleEn: null,
    startTime: Temporal.ZonedDateTime.from(`${start}[Asia/Tokyo]`),
    endTime: end ? Temporal.ZonedDateTime.from(`${end}[Asia/Tokyo]`) : null,
    sourceType: 'topic',
    sourceId: 's',
    createdAt: Temporal.Instant.from('2026-07-01T00:00:00Z'),
  };
}

describe('buildDayAgenda', () => {
  it('puts an ongoing multi-day event in the band', () => {
    const { band, bars, milestones } = buildDayAgenda(
      [ev('span', '2026-06-25T00:00:00', '2026-08-14T23:59:00')],
      DAY,
    );
    expect(band).toHaveLength(1);
    expect(bars).toHaveLength(0);
    expect(milestones).toHaveLength(0);
  });

  it('puts an allDay event on the day in the band', () => {
    const { band, bars } = buildDayAgenda(
      [ev('allDay', '2026-07-09T00:00:00')],
      DAY,
    );
    expect(band).toHaveLength(1);
    expect(bars).toHaveLength(0);
  });

  it('renders a same-day span as a closed bar', () => {
    const { bars } = buildDayAgenda(
      [ev('span', '2026-07-09T06:00:00', '2026-07-09T12:00:00')],
      DAY,
    );
    expect(bars).toHaveLength(1);
    expect(bars[0].openStart).toBe(false);
    expect(bars[0].openEnd).toBe(false);
    expect(bars[0].startFrac).toBeCloseTo(0.25);
    expect(bars[0].endFrac).toBeCloseTo(0.5);
  });

  it('marks a bar starting today but ending later as openEnd', () => {
    const { bars } = buildDayAgenda(
      [ev('span', '2026-07-09T20:00:00', '2026-07-18T05:59:00')],
      DAY,
    );
    expect(bars).toHaveLength(1);
    expect(bars[0].openStart).toBe(false);
    expect(bars[0].openEnd).toBe(true);
    expect(bars[0].endFrac).toBe(1);
  });

  it('marks a bar ending today but starting earlier as openStart', () => {
    const { bars } = buildDayAgenda(
      [ev('span', '2026-07-01T00:00:00', '2026-07-09T10:00:00')],
      DAY,
    );
    expect(bars).toHaveLength(1);
    expect(bars[0].openStart).toBe(true);
    expect(bars[0].openEnd).toBe(false);
    expect(bars[0].startFrac).toBe(0);
    expect(bars[0].endFrac).toBeCloseTo(10 / 24);
  });

  it('renders a mark as a milestone', () => {
    const { milestones, bars, band } = buildDayAgenda(
      [ev('mark', '2026-07-09T12:00:00')],
      DAY,
    );
    expect(milestones).toHaveLength(1);
    expect(milestones[0].frac).toBeCloseTo(0.5);
    expect(bars).toHaveLength(0);
    expect(band).toHaveLength(0);
  });

  it('splits overlapping bars into two lanes', () => {
    const { bars } = buildDayAgenda(
      [
        ev('span', '2026-07-09T06:00:00', '2026-07-09T10:00:00'),
        ev('span', '2026-07-09T08:00:00', '2026-07-09T12:00:00'),
      ],
      DAY,
    );
    expect(bars).toHaveLength(2);
    expect(bars.map((b) => b.lane).sort()).toEqual([0, 1]);
    expect(bars.every((b) => b.laneCount === 2)).toBe(true);
  });

  it('keeps non-overlapping bars in a single lane', () => {
    const { bars } = buildDayAgenda(
      [
        ev('span', '2026-07-09T06:00:00', '2026-07-09T08:00:00'),
        ev('span', '2026-07-09T09:00:00', '2026-07-09T11:00:00'),
      ],
      DAY,
    );
    expect(bars.every((b) => b.lane === 0 && b.laneCount === 1)).toBe(true);
  });
});
