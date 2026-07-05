import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { parseExtractedEvents } from './extract-events';

// A mid-day JST publication moment — the sentinel must resolve to this exact
// wall-clock time for span events and to its calendar day for multiDay.
const pub = Temporal.ZonedDateTime.from(
  '2026-07-01T12:34:00+09:00[Asia/Tokyo]',
);

describe('parseExtractedEvents', () => {
  it('resolves the publishedAt sentinel to the publication moment (span)', () => {
    const [event] = parseExtractedEvents(
      [
        {
          type: 'span',
          title: 'プレゼント期間',
          start: 'publishedAt',
          end: '2026-07-13T05:59:00+09:00',
        },
      ],
      pub,
    );
    expect(event).toBeDefined();
    if (event.type !== 'span') throw new Error('expected span');
    expect(event.start.toString()).toBe(pub.toString());
    expect(event.end.toString({ timeZoneName: 'never' })).toBe(
      '2026-07-13T05:59:00+09:00',
    );
  });

  it('resolves the sentinel to the publication day for multiDay (date granularity)', () => {
    const [event] = parseExtractedEvents(
      [
        {
          type: 'multiDay',
          title: '配布期間',
          start: 'publishedAt',
          end: '2026-07-13',
        },
      ],
      pub,
    );
    expect(event).toBeDefined();
    if (event.type !== 'multiDay') throw new Error('expected multiDay');
    expect(event.start.toPlainDate().toString()).toBe('2026-07-01');
    expect(event.start.toPlainTime().toString()).toBe('00:00:00');
  });

  it('still parses explicit starts', () => {
    const events = parseExtractedEvents(
      [
        {
          type: 'span',
          title: 'イベント',
          start: '2026-07-05T12:00:00+09:00',
          end: '2026-07-06T12:00:00+09:00',
        },
      ],
      pub,
    );
    expect(events).toHaveLength(1);
  });

  it('drops an event whose end precedes its start', () => {
    const events = parseExtractedEvents(
      [
        {
          type: 'span',
          title: '逆転イベント',
          start: '2026-07-10T12:00:00+09:00',
          end: '2026-07-09T12:00:00+09:00',
        },
      ],
      pub,
    );
    expect(events).toEqual([]);
  });

  it('drops a sentinel-start event whose end hallucinated a far-future year', () => {
    const events = parseExtractedEvents(
      [
        {
          type: 'span',
          title: '年ズレ',
          start: 'publishedAt',
          end: '2028-07-13T05:59:00+09:00',
        },
      ],
      pub,
    );
    expect(events).toEqual([]);
  });

  it('keeps a sentinel-start event with a plausible end', () => {
    const events = parseExtractedEvents(
      [
        {
          type: 'multiDay',
          title: 'プレゼント期間',
          start: 'publishedAt',
          end: '2026-07-13',
        },
      ],
      pub,
    );
    expect(events).toHaveLength(1);
  });

  it('drops only the malformed event, keeping the rest of the batch', () => {
    const events = parseExtractedEvents(
      [
        {
          type: 'mark',
          title: '生放送',
          timestamp: '2026-07-02T20:00:00+09:00',
        },
        { type: 'span', title: '壊れた', start: 'not-a-date', end: 'nope' },
        { type: 'allDay', title: '一日イベント', date: '2026-07-04' },
      ],
      pub,
    );
    expect(events.map((e) => e.title)).toEqual(['生放送', '一日イベント']);
  });

  it('rejects the sentinel in end/date/timestamp fields', () => {
    const events = parseExtractedEvents(
      [
        {
          type: 'span',
          title: '終了未定',
          start: '2026-07-01T00:00:00+09:00',
          end: 'publishedAt',
        },
        { type: 'allDay', title: '当日', date: 'publishedAt' },
        { type: 'mark', title: '瞬間', timestamp: 'publishedAt' },
      ],
      pub,
    );
    expect(events).toEqual([]);
  });
});
