import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import {
  parseRtml,
  serializeToRtml,
  stripTimeEventTags,
  tagsPreserveContent,
  type Block,
} from '@hiroba/richtext';

import {
  resolveEventRefs,
  stripTaggingScaffold,
  type TaggableEvent,
} from './tag-events';

const spanEvent: TaggableEvent = {
  id: 'ev_span1',
  type: 'span',
  titleJa: 'プレゼント期間',
  startTime: Temporal.ZonedDateTime.from(
    '2026-07-01T12:00:00+09:00[Asia/Tokyo]',
  ),
  endTime: Temporal.ZonedDateTime.from('2026-07-13T05:59:00+09:00[Asia/Tokyo]'),
};

const allDayEvent: TaggableEvent = {
  id: 'ev_allday1',
  type: 'allDay',
  titleJa: '一日イベント',
  startTime: Temporal.ZonedDateTime.from(
    '2026-07-04T00:00:00+09:00[Asia/Tokyo]',
  ),
  endTime: null,
};

describe('resolveEventRefs', () => {
  it('rewrites <event n> to the saved id/start/end (ISO+offset for span)', () => {
    const resolved = resolveEventRefs('<p><event n="1">期間 まで</event></p>', [
      spanEvent,
    ]);
    expect(resolved).toBe(
      '<p><event id="ev_span1" start="2026-07-01T12:00:00+09:00" end="2026-07-13T05:59:00+09:00">期間 まで</event></p>',
    );
  });

  it('emits date-only values for date-granularity types and omits a null end', () => {
    const resolved = resolveEventRefs('<p><event n="2">当日</event></p>', [
      spanEvent,
      allDayEvent,
    ]);
    expect(resolved).toBe(
      '<p><event id="ev_allday1" start="2026-07-04">当日</event></p>',
    );
  });

  it('fails on an unknown n', () => {
    expect(
      resolveEventRefs('<p><event n="3">x</event></p>', [spanEvent]),
    ).toBeNull();
  });

  it('fails on an <event> tag that strays from the n form', () => {
    expect(resolveEventRefs('<p><event>x</event></p>', [spanEvent])).toBeNull();
    expect(
      resolveEventRefs('<p><event n="1" foo="bar">x</event></p>', [spanEvent]),
    ).toBeNull();
  });

  it('resolves to markup that parses into a valid tagged tree', () => {
    const resolved = resolveEventRefs(
      '<doctitle>T</doctitle><p><event n="1">プレゼント期間 <time datetime="2026-07-13T05:59:00+09:00">7月13日 5:59</time> まで</event></p>',
      [spanEvent],
    );
    expect(resolved).not.toBeNull();
    const { blocks } = parseRtml(resolved as string);
    expect(blocks).toEqual([
      {
        type: 'paragraph',
        children: [
          {
            type: 'event',
            id: 'ev_span1',
            start: '2026-07-01T12:00:00+09:00',
            end: '2026-07-13T05:59:00+09:00',
            children: [
              'プレゼント期間 ',
              {
                type: 'time',
                datetime: '2026-07-13T05:59:00+09:00',
                children: ['7月13日 5:59'],
              },
              ' まで',
            ],
          },
        ],
      },
    ]);
  });
});

describe('stripTaggingScaffold', () => {
  it('drops the <pubdate>/<eventlist> context the model echoes back', () => {
    const echoed =
      '<pubdate>2026年7月5日（日） 12:00</pubdate>\n' +
      '<eventlist>\n1. [span] プレゼント期間 — 2026-07-01T12:00:00+09:00\n</eventlist>\n' +
      '<doctitle>T</doctitle><p>本文</p>';
    expect(stripTaggingScaffold(echoed)).toBe(
      '<doctitle>T</doctitle><p>本文</p>',
    );
  });

  it('strips the leading tags in either order', () => {
    const swapped =
      '<eventlist>\n1. x\n</eventlist><pubdate>d</pubdate><doctitle>T</doctitle>';
    expect(stripTaggingScaffold(swapped)).toBe('<doctitle>T</doctitle>');
  });

  it('leaves a clean document untouched', () => {
    const doc = '<doctitle>T</doctitle><p>本文</p>';
    expect(stripTaggingScaffold(doc)).toBe(doc);
  });

  it('does not strip a <pubdate> that only appears inside the body', () => {
    // The scaffold lives ahead of <doctitle>; a stray tag deeper in the doc is
    // left alone (it would still fail parsing, as it should).
    const doc = '<doctitle>T</doctitle><p><pubdate>x</pubdate></p>';
    expect(stripTaggingScaffold(doc)).toBe(doc);
  });
});

describe('tagging validation pipeline (resolve → parse → compare)', () => {
  const original: Block[] = [
    {
      type: 'paragraph',
      children: ['プレゼント期間 2026年7月13日（月）5:59 まで'],
    },
  ];
  const originalRtml = serializeToRtml({ title: 'T', blocks: original });

  it('accepts a faithful model output', () => {
    // What a correct model response looks like: same markup, tags inserted.
    const modelOutput = originalRtml.replace(
      '<p>プレゼント期間 2026年7月13日（月）5:59 まで</p>',
      '<p><event n="1">プレゼント期間 <time datetime="2026-07-13T05:59:00+09:00">2026年7月13日（月）5:59</time> まで</event></p>',
    );
    const resolved = resolveEventRefs(modelOutput, [spanEvent]);
    expect(resolved).not.toBeNull();
    const tagged = parseRtml(resolved as string).blocks;
    expect(tagsPreserveContent(original, tagged)).toBe(true);
    // Stripping splices children in place, so text nodes stay split — the
    // canonical-serialization comparison is what proves equivalence.
    expect(
      serializeToRtml({ title: 'T', blocks: stripTimeEventTags(tagged) }),
    ).toBe(originalRtml);
  });

  it('rejects a model output that edited the text while tagging', () => {
    const modelOutput = originalRtml.replace(
      '<p>プレゼント期間 2026年7月13日（月）5:59 まで</p>',
      // "まで" dropped while inserting the tags
      '<p><event n="1">プレゼント期間 <time datetime="2026-07-13T05:59:00+09:00">2026年7月13日（月）5:59</time></event></p>',
    );
    const resolved = resolveEventRefs(modelOutput, [spanEvent]);
    expect(resolved).not.toBeNull();
    const tagged = parseRtml(resolved as string).blocks;
    expect(tagsPreserveContent(original, tagged)).toBe(false);
  });
});
