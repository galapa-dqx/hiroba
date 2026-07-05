import { describe, expect, it } from 'vitest';

import { reconcileAttributes } from './reconcile';
import type { Block } from './schema';

describe('reconcileAttributes', () => {
  it('restores a URL the translation mangled (the cache.hiroba.dqx.jp bug)', () => {
    const source: Block[] = [
      {
        type: 'image',
        src: 'https://cache.hiroba.dqx.jp/dq_resource/imgs/a.jpg',
        alt: 'スクリーンショット',
      },
    ];
    const translated: Block[] = [
      {
        // host corrupted: `hiroba` label dropped → dead host
        type: 'image',
        src: 'https://cache.dqx.jp/dq_resource/imgs/a.jpg',
        alt: 'Screenshot',
      },
    ];

    const report = reconcileAttributes(source, translated);

    expect(translated[0]).toMatchObject({
      src: 'https://cache.hiroba.dqx.jp/dq_resource/imgs/a.jpg',
      alt: 'Screenshot', // translated alt is preserved
    });
    expect(report.repairs).toEqual([
      {
        nodeType: 'image',
        index: 0,
        field: 'src',
        from: 'https://cache.dqx.jp/dq_resource/imgs/a.jpg',
        to: 'https://cache.hiroba.dqx.jp/dq_resource/imgs/a.jpg',
      },
    ]);
    expect(report.divergences).toEqual([]);
  });

  it('returns an empty report when nothing drifted', () => {
    const blocks: Block[] = [
      { type: 'image', src: 'https://cache.hiroba.dqx.jp/a.jpg', alt: 'a' },
      {
        type: 'paragraph',
        children: [{ type: 'link', href: 'https://dqx.jp/x', children: ['t'] }],
      },
    ];
    const source = structuredClone(blocks);
    const translated = structuredClone(blocks);

    const report = reconcileAttributes(source, translated);

    expect(report.repairs).toEqual([]);
    expect(report.divergences).toEqual([]);
    expect(translated).toEqual(source);
  });

  it('never rewrites linguistic fields (alt, image text spans, badge text)', () => {
    const source: Block[] = [
      {
        type: 'image',
        src: 'https://cache.hiroba.dqx.jp/a.jpg',
        alt: 'もとの説明',
        text: ['日本語の行'],
      },
      {
        type: 'paragraph',
        children: [{ type: 'badge', text: '新', variant: 'new' }],
      },
    ];
    const translated: Block[] = [
      {
        type: 'image',
        src: 'https://cache.hiroba.dqx.jp/a.jpg',
        alt: 'the description',
        text: ['the English line'],
      },
      {
        type: 'paragraph',
        children: [{ type: 'badge', text: 'New', variant: 'new' }],
      },
    ];

    const report = reconcileAttributes(source, translated);

    expect(report.repairs).toEqual([]);
    // linguistic content stays in English
    expect((translated[0] as { alt: string }).alt).toBe('the description');
    expect((translated[0] as { text: string[] }).text).toEqual([
      'the English line',
    ]);
  });

  it('restores link href, icon src, and color value inside inline content', () => {
    const source: Block[] = [
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            href: 'https://hiroba.dqx.jp/sc/x',
            children: ['見る'],
          },
          { type: 'icon', src: 'https://faceicon.dqx.jp/i/1.png', alt: 'icon' },
          { type: 'color', value: '#CC0033', children: ['赤'] },
        ],
      },
    ];
    const translated: Block[] = [
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            href: 'https://hiroba.dqx.jp/sc/X',
            children: ['See'],
          },
          { type: 'icon', src: 'https://faceicon.dqx.jp/i/2.png', alt: 'icon' },
          { type: 'color', value: '#CC0000', children: ['red'] },
        ],
      },
    ];

    const report = reconcileAttributes(source, translated);

    const children = (translated[0] as { children: Record<string, unknown>[] })
      .children;
    expect(children[0].href).toBe('https://hiroba.dqx.jp/sc/x');
    expect(children[1].src).toBe('https://faceicon.dqx.jp/i/1.png');
    expect(children[2].value).toBe('#CC0033');
    expect(report.repairs.map((r) => r.field).sort()).toEqual([
      'href',
      'src',
      'value',
    ]);
  });

  it('restores a link href mangled inside an image caption', () => {
    const src = 'https://cache.hiroba.dqx.jp/h.jpg';
    const source: Block[] = [
      {
        type: 'image',
        src,
        caption: [
          {
            type: 'link',
            href: 'https://hiroba.dqx.jp/sc/shop/',
            children: ['ショップ'],
          },
        ],
      },
    ];
    const translated: Block[] = [
      {
        type: 'image',
        src,
        caption: [
          // the translation dropped the `hiroba` label from the caption's link
          {
            type: 'link',
            href: 'https://dqx.jp/sc/shop/',
            children: ['the shop'],
          },
        ],
      },
    ];

    const report = reconcileAttributes(source, translated);

    const caption = (translated[0] as { caption: Record<string, unknown>[] })
      .caption;
    expect(caption[0].href).toBe('https://hiroba.dqx.jp/sc/shop/');
    // the caption's translated text is linguistic and left untouched
    expect(caption[0].children).toEqual(['the shop']);
    expect(report.repairs).toContainEqual(
      expect.objectContaining({ nodeType: 'link', field: 'href' }),
    );
  });

  it('restores a heading anchor id the translation dropped', () => {
    const source: Block[] = [
      { type: 'heading', level: 2, children: ['見出し'], anchor: 'dra' },
    ];
    const translated: Block[] = [
      // kept the translated text, dropped the non-linguistic anchor attribute
      { type: 'heading', level: 2, children: ['Heading'] },
    ];

    const report = reconcileAttributes(source, translated);

    expect((translated[0] as { anchor?: string }).anchor).toBe('dra');
    expect((translated[0] as { children: string[] }).children).toEqual([
      'Heading',
    ]);
    expect(report.repairs).toContainEqual(
      expect.objectContaining({ nodeType: 'heading', field: 'anchor' }),
    );
  });

  it('reconciles attributes nested deep inside containers', () => {
    const mk = (src: string): Block[] => [
      {
        type: 'table',
        rows: [[{ children: [{ type: 'image', src, alt: 'x' }] }]],
      },
    ];
    const source = mk('https://cache.hiroba.dqx.jp/deep.jpg');
    const translated = mk('https://cache.dqx.jp/deep.jpg');

    const report = reconcileAttributes(source, translated);

    expect(report.repairs).toHaveLength(1);
    expect(report.repairs[0].nodeType).toBe('image');
  });

  it('adds a dropped attribute and removes a spurious one', () => {
    const source: Block[] = [
      {
        type: 'image',
        src: 'https://cache.hiroba.dqx.jp/a.jpg',
        href: 'https://dqx.jp/go',
        external: true,
      },
    ];
    const translated: Block[] = [
      // dropped `external`, added a bogus `variant`
      {
        type: 'image',
        src: 'https://cache.hiroba.dqx.jp/a.jpg',
        href: 'https://dqx.jp/go',
        variant: 'huge',
      } as Block,
    ];

    const report = reconcileAttributes(source, translated);

    expect(translated[0]).toEqual({
      type: 'image',
      src: 'https://cache.hiroba.dqx.jp/a.jpg',
      href: 'https://dqx.jp/go',
      external: true,
    });
    expect(report.repairs.map((r) => r.field).sort()).toEqual([
      'external',
      'variant',
    ]);
  });

  it('restores the responsive sources array', () => {
    const source: Block[] = [
      {
        type: 'image',
        src: 'https://cache.hiroba.dqx.jp/a.jpg',
        sources: [
          { src: 'https://cache.hiroba.dqx.jp/a-1920.jpg', minWidth: 1920 },
        ],
      },
    ];
    const translated: Block[] = [
      {
        type: 'image',
        src: 'https://cache.hiroba.dqx.jp/a.jpg',
        sources: [{ src: 'https://cache.dqx.jp/a-1920.jpg', minWidth: 1920 }],
      },
    ];

    const report = reconcileAttributes(source, translated);

    expect(
      (translated[0] as { sources: { src: string }[] }).sources[0].src,
    ).toBe('https://cache.hiroba.dqx.jp/a-1920.jpg');
    expect(report.repairs).toHaveLength(1);
    expect(report.repairs[0].field).toBe('sources');
  });

  it('records a divergence and skips a bucket the translation resized', () => {
    const source: Block[] = [
      { type: 'image', src: 'https://cache.hiroba.dqx.jp/a.jpg' },
      { type: 'image', src: 'https://cache.hiroba.dqx.jp/b.jpg' },
    ];
    const translated: Block[] = [
      // dropped the second image AND mangled the first's host
      { type: 'image', src: 'https://cache.dqx.jp/a.jpg' },
    ];

    const report = reconcileAttributes(source, translated);

    // Can't pair 2↔1: the mangled src is left as-is, but loudly reported.
    expect(report.repairs).toEqual([]);
    expect(report.divergences).toEqual([
      { nodeType: 'image', sourceCount: 2, translatedCount: 1 },
    ]);
    expect((translated[0] as { src: string }).src).toBe(
      'https://cache.dqx.jp/a.jpg',
    );
  });

  it('does not cross-contaminate distinct node types', () => {
    // An image count mismatch must not stop links from reconciling.
    const source: Block[] = [
      { type: 'image', src: 'https://cache.hiroba.dqx.jp/a.jpg' },
      {
        type: 'paragraph',
        children: [
          { type: 'link', href: 'https://dqx.jp/ok', children: ['x'] },
        ],
      },
    ];
    const translated: Block[] = [
      // image dropped (divergence), but the link is intact and mangled
      {
        type: 'paragraph',
        children: [
          { type: 'link', href: 'https://dqx.jp/BAD', children: ['x'] },
        ],
      },
    ];

    const report = reconcileAttributes(source, translated);

    expect(report.divergences).toEqual([
      { nodeType: 'image', sourceCount: 1, translatedCount: 0 },
    ]);
    expect(report.repairs).toEqual([
      {
        nodeType: 'link',
        index: 0,
        field: 'href',
        from: 'https://dqx.jp/BAD',
        to: 'https://dqx.jp/ok',
      },
    ]);
  });
});

describe('time/event annotation attributes', () => {
  it('restores mutated datetime/id/start from the source tree', () => {
    const source: Block[] = [
      {
        type: 'paragraph',
        children: [
          {
            type: 'event',
            id: 'ev_1',
            start: '2026-07-01T12:00:00+09:00',
            end: '2026-07-13T05:59:00+09:00',
            children: [
              '期間 ',
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
    ];
    const translated: Block[] = [
      {
        type: 'paragraph',
        children: [
          {
            type: 'event',
            id: 'ev_MANGLED',
            start: '2025-07-01T12:00:00+09:00', // year drifted
            end: '2026-07-13T05:59:00+09:00',
            children: [
              'Period: until ',
              {
                type: 'time',
                datetime: '2026-07-13T05:59:00+0900', // offset format drifted
                children: ['July 13, 5:59'],
              },
            ],
          },
        ],
      },
    ];

    const report = reconcileAttributes(source, translated);

    expect(translated[0]).toMatchObject({
      children: [
        {
          type: 'event',
          id: 'ev_1',
          start: '2026-07-01T12:00:00+09:00',
          children: [
            'Period: until ',
            { type: 'time', datetime: '2026-07-13T05:59:00+09:00' },
          ],
        },
      ],
    });
    expect(report.repairs).toHaveLength(3);
    expect(report.divergences).toEqual([]);
  });
});
