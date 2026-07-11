import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import type { Event, Residual } from '@hiroba/db';

import { buildAdjudicationInput, parseAdjudication } from './adjudicate-events';

const z = (s: string) =>
  Temporal.PlainDate.from(s).toZonedDateTime('Asia/Tokyo');

/** A stored candidate event with only the fields the adjudicator reads. */
function candidate(id: string, title: string): Event {
  return {
    id,
    type: 'multiDay',
    titleJa: title,
    startTime: z('2026-06-25'),
    endTime: z('2026-07-12'),
    sourceType: 'news',
    sourceId: 'x',
    createdAt: Temporal.Instant.from('2026-06-25T00:00:00Z'),
  };
}

function residual(title: string, candidates: Event[]): Residual {
  return {
    index: 0,
    event: {
      type: 'multiDay',
      titleJa: title,
      startTime: z('2026-06-25'),
      endTime: z('2026-07-23'),
    },
    candidates,
  };
}

describe('parseAdjudication', () => {
  const residuals: Residual[] = [
    residual('セールA', [
      candidate('c1', 'セールB'),
      candidate('c2', 'セールC'),
    ]),
    residual('セールD', [candidate('c3', 'セールE')]),
  ];

  it('maps each verdict to the named candidate id', () => {
    const out = parseAdjudication(
      JSON.stringify([
        { id: 0, same_as: 'c2' },
        { id: 1, same_as: null },
      ]),
      residuals,
    );
    expect(out).toEqual(['c2', null]);
  });

  it('rejects a same_as that is not one of that residual’s candidates', () => {
    const out = parseAdjudication(
      JSON.stringify([{ id: 0, same_as: 'c3' }]), // c3 belongs to residual 1
      residuals,
    );
    expect(out).toEqual([null, null]);
  });

  it('falls back to all-null on malformed JSON', () => {
    expect(parseAdjudication('not json', residuals)).toEqual([null, null]);
  });

  it('defaults missing verdicts to null', () => {
    const out = parseAdjudication(
      JSON.stringify([{ id: 0, same_as: 'c1' }]), // no entry for id 1
      residuals,
    );
    expect(out).toEqual(['c1', null]);
  });
});

describe('buildAdjudicationInput', () => {
  it('serializes new + candidate briefs with ids the model can echo back', () => {
    const input = buildAdjudicationInput([
      residual('セールA', [candidate('c1', 'セールB')]),
    ]);
    const parsed = JSON.parse(input);
    expect(parsed[0]).toMatchObject({
      id: 0,
      new: { title: 'セールA', type: 'multiDay' },
      candidates: [{ id: 'c1', title: 'セールB' }],
    });
  });
});
