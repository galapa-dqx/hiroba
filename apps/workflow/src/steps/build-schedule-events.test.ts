import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import type { TsuyosaForecast } from '@hiroba/scraper';

import { buildScheduleEvents } from './build-schedule-events';

const NOW = Temporal.Instant.from('2026-07-11T00:00:00Z');
const d = (s: string) => Temporal.PlainDate.from(s);

const forecast: TsuyosaForecast = {
  bootcamp: {
    content: 'bootcamp',
    periodDays: 7,
    guideSlug: 'guide_4_61',
    slots: [
      { date: d('2026-07-05'), bossJa: '練武の鎧竜', iconKey: '4.png' },
      { date: d('2026-07-12'), bossJa: '練武の機神', iconKey: '0.png' },
    ],
  },
  panigarm: {
    content: 'panigarm',
    periodDays: 3,
    guideSlug: 'guide_4_59',
    slots: [
      { date: d('2026-07-11'), bossJa: 'じげんりゅう', iconKey: 'x.png' },
    ],
  },
  defense: [
    {
      date: d('2026-07-11'),
      startMinute: 360,
      durationMinutes: 60,
      iconUrl: 'i/12',
    },
    {
      date: d('2026-07-11'),
      startMinute: 420,
      durationMinutes: 60,
      iconUrl: 'i/12',
    },
    {
      date: d('2026-07-11'),
      startMinute: 480,
      durationMinutes: 60,
      iconUrl: 'i/19',
    },
  ],
  metal: [
    {
      date: d('2026-07-11'),
      startMinute: 360,
      durationMinutes: 30,
      iconUrl: 'm/1',
    },
  ],
  abyss: [
    { date: d('2026-07-11'), iconUrl: 't/a' },
    { date: d('2026-07-11'), iconUrl: 't/b' },
  ],
};

const bossRows = buildScheduleEvents(forecast, NOW).filter(
  (r) => !r.sourceId?.includes('#'),
);

describe('buildScheduleEvents boss rotations', () => {
  const rows = bossRows;

  it('emits a span per boss slot, tagged as schedule', () => {
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.type).toBe('span');
      expect(r.sourceType).toBe('schedule');
    }
    expect(rows.map((r) => r.sourceId)).toEqual([
      'bootcamp',
      'bootcamp',
      'panigarm',
    ]);
  });

  it('titles as "section：boss"', () => {
    expect(rows[0].titleJa).toBe('ヴァリーブートキャンプ：練武の鎧竜');
    expect(rows[2].titleJa).toBe('源世庫パニガルム：じげんりゅう');
  });

  it('starts at 06:00 JST and ends at the next slot changeover', () => {
    expect(rows[0].startTime.toString()).toContain('2026-07-05T06:00:00');
    expect(rows[0].endTime!.toString()).toContain('2026-07-12T06:00:00');
  });

  it('ends the final slot one period after its start', () => {
    // bootcamp last slot (07/12) → +7d; panigarm only slot (07/11) → +3d
    expect(rows[1].endTime!.toString()).toContain('2026-07-19T06:00:00');
    expect(rows[2].startTime.toString()).toContain('2026-07-11T06:00:00');
    expect(rows[2].endTime!.toString()).toContain('2026-07-14T06:00:00');
  });

  it('produces stable, prefixed ids', () => {
    expect(rows[0].id).toMatch(/^sched-[0-9a-f]{8}$/);
    expect(buildScheduleEvents(forecast, NOW).map((r) => r.id)).toEqual(
      buildScheduleEvents(forecast, NOW).map((r) => r.id),
    );
  });
});

describe('buildScheduleEvents icon sections', () => {
  const rows = buildScheduleEvents(forecast, NOW);
  const bySource = (prefix: string) =>
    rows.filter((r) => r.sourceId?.startsWith(prefix));

  it('merges contiguous same-icon 防衛軍 hours, splits on icon change', () => {
    const defense = bySource('defense#');
    expect(defense).toHaveLength(2); // 12 (06–08 merged) + 19 (08–09)
    const merged = defense.find((r) => r.sourceId === 'defense#i/12')!;
    expect(merged.startTime.toString()).toContain('2026-07-11T06:00:00');
    expect(merged.endTime!.toString()).toContain('2026-07-11T08:00:00');
    expect(merged.titleJa).toBe('アストルティア防衛軍');
  });

  it('encodes the icon url in sourceId', () => {
    expect(bySource('metal#')[0].sourceId).toBe('metal#m/1');
    expect(bySource('metal#')[0].endTime!.toString()).toContain(
      '2026-07-11T06:30:00',
    );
  });

  it('emits one allDay event per 深淵 boss icon', () => {
    const abyss = bySource('abyss#');
    expect(abyss.map((r) => r.sourceId).sort()).toEqual([
      'abyss#t/a',
      'abyss#t/b',
    ]);
    expect(abyss[0].type).toBe('allDay');
    expect(abyss[0].startTime.toString()).toContain('2026-07-11T00:00:00');
    expect(abyss[0].endTime).toBeNull();
  });
});
