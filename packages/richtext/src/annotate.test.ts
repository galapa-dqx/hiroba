import { describe, expect, it } from 'vitest';

import {
  countTimeEventTags,
  stripTimeEventTags,
  tagsPreserveContent,
} from './annotate';
import type { Block, Inline } from './schema';

const time = (datetime: string, ...children: Inline[]): Inline => ({
  type: 'time',
  datetime,
  children,
});

const original: Block[] = [
  { type: 'heading', level: 2, children: ['プレゼントのお知らせ'] },
  {
    type: 'paragraph',
    children: [
      'プレゼント期間 2026年7月13日（月）5:59 まで',
      { type: 'break' },
      { type: 'strong', children: ['お見逃しなく！'] },
    ],
  },
];

// The same document as an LLM tagging pass would return it: the dated phrase
// wrapped in <event>, the literal timestamp wrapped in <time>, text split.
const tagged: Block[] = [
  { type: 'heading', level: 2, children: ['プレゼントのお知らせ'] },
  {
    type: 'paragraph',
    children: [
      {
        type: 'event',
        id: 'ev_1',
        start: '2026-07-01T12:00:00+09:00',
        end: '2026-07-13T05:59:00+09:00',
        children: [
          'プレゼント期間 ',
          time('2026-07-13T05:59:00+09:00', '2026年7月13日（月）5:59'),
          ' まで',
        ],
      },
      { type: 'break' },
      { type: 'strong', children: ['お見逃しなく！'] },
    ],
  },
];

describe('stripTimeEventTags', () => {
  it('splices time/event children back into the parent run', () => {
    const stripped = stripTimeEventTags(tagged);
    expect(tagsPreserveContent(original, stripped)).toBe(true);
    // No time/event nodes remain.
    expect(countTimeEventTags(stripped)).toEqual({ timeTags: 0, eventTags: 0 });
  });

  it('is idempotent and does not mutate its input', () => {
    const once = stripTimeEventTags(tagged);
    const twice = stripTimeEventTags(once);
    expect(twice).toEqual(once);
    expect(countTimeEventTags(tagged)).toEqual({ timeTags: 1, eventTags: 1 });
  });

  it('reaches nested sites (infoBox > table cell > strong > time)', () => {
    const deep: Block[] = [
      {
        type: 'infoBox',
        variant: 'highlight',
        children: [
          {
            type: 'table',
            rows: [
              [
                {
                  children: [
                    {
                      type: 'strong',
                      children: [time('2026-08-01', '8月1日')],
                    },
                  ],
                },
              ],
            ],
          },
        ],
      },
    ];
    const stripped = stripTimeEventTags(deep);
    expect(countTimeEventTags(stripped)).toEqual({ timeTags: 0, eventTags: 0 });
    expect(stripped).toEqual([
      {
        type: 'infoBox',
        variant: 'highlight',
        children: [
          {
            type: 'table',
            rows: [[{ children: [{ type: 'strong', children: ['8月1日'] }] }]],
          },
        ],
      },
    ]);
  });
});

describe('tagsPreserveContent', () => {
  it('accepts a faithful tagging despite split text nodes', () => {
    expect(tagsPreserveContent(original, tagged)).toBe(true);
  });

  it('accepts the untagged tree itself', () => {
    expect(tagsPreserveContent(original, original)).toBe(true);
  });

  it('rejects altered text', () => {
    const mutated = structuredClone(tagged);
    // "お見逃しなく！" → translated/paraphrased
    (mutated[1] as Extract<Block, { type: 'paragraph' }>).children[2] = {
      type: 'strong',
      children: ["Don't miss out!"],
    };
    expect(tagsPreserveContent(original, mutated)).toBe(false);
  });

  it('rejects a dropped node', () => {
    const mutated = structuredClone(tagged);
    (mutated[1] as Extract<Block, { type: 'paragraph' }>).children.splice(1, 1); // drop the <br>
    expect(tagsPreserveContent(original, mutated)).toBe(false);
  });

  it('rejects reordered blocks', () => {
    expect(
      tagsPreserveContent(original, [...tagged].reverse() as Block[]),
    ).toBe(false);
  });

  it('rejects an altered non-linguistic attribute', () => {
    const withLink: Block[] = [
      {
        type: 'paragraph',
        children: [{ type: 'link', href: '/a/', children: ['x'] }],
      },
    ];
    const mangled: Block[] = [
      {
        type: 'paragraph',
        children: [{ type: 'link', href: '/b/', children: ['x'] }],
      },
    ];
    expect(tagsPreserveContent(withLink, mangled)).toBe(false);
  });
});
