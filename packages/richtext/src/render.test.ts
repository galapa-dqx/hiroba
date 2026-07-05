import { describe, expect, it } from 'vitest';

import { rewriteArticleHref } from './link-url';
import { renderBlocks } from './render';
import type { Block } from './schema';

describe('renderBlocks', () => {
  it('renders paragraphs with nested inline formatting, escaping text', () => {
    const blocks: Block[] = [
      {
        type: 'paragraph',
        children: [
          'a < b & ',
          {
            type: 'strong',
            children: [{ type: 'color', value: '#C03', children: ['red'] }],
          },
          { type: 'break' },
          {
            type: 'link',
            href: 'https://x/?a=1&b=2',
            external: true,
            children: ['go'],
          },
        ],
      },
    ];
    expect(renderBlocks(blocks)).toBe(
      '<p>a &lt; b &amp; <strong><span style="color:#C03">red</span></strong><br>' +
        '<a href="https://x/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">go</a></p>',
    );
  });

  it('renders headings, dividers, and images (src left as-is by default)', () => {
    expect(
      renderBlocks([
        { type: 'heading', level: 2, children: ['H'], variant: 'quest' },
      ]),
    ).toBe('<h2 class="rt-h-quest">H</h2>');
    // an anchor becomes an id (before class) for in-page linking
    expect(
      renderBlocks([
        { type: 'heading', level: 2, children: ['H'], anchor: 'dra' },
        {
          type: 'heading',
          level: 3,
          children: ['Q'],
          variant: 'quest',
          anchor: 'q1',
        },
      ]),
    ).toBe('<h2 id="dra">H</h2><h3 id="q1" class="rt-h-quest">Q</h3>');
    expect(renderBlocks([{ type: 'divider' }])).toBe('<hr>');
    expect(
      renderBlocks([
        { type: 'image', src: 'https://cache.hiroba.dqx.jp/a.jpg', alt: 'x' },
      ]),
    ).toBe(
      '<img class="rt-image" src="https://cache.hiroba.dqx.jp/a.jpg" alt="x">',
    );
  });

  it('wraps a linked image in an anchor (external adds target/rel)', () => {
    expect(
      renderBlocks([
        {
          type: 'image',
          src: '/a.jpg',
          href: 'https://example.com/',
          external: true,
        },
      ]),
    ).toBe(
      '<a class="rt-image-link" href="https://example.com/" target="_blank" rel="noopener noreferrer">' +
        '<img class="rt-image" src="/a.jpg" alt=""></a>',
    );
  });

  it('wraps a captioned video in a figure like a captioned image', () => {
    expect(
      renderBlocks([
        {
          type: 'video',
          provider: 'youtube',
          src: 'https://www.youtube.com/embed/x',
          caption: [
            { type: 'color', value: '#993300', children: ['＜ 映像 ＞'] },
          ],
        },
      ]),
    ).toBe(
      '<figure class="rt-figure">' +
        '<div class="rt-video"><iframe src="https://www.youtube.com/embed/x" allowfullscreen loading="lazy"></iframe></div>' +
        '<figcaption class="rt-caption"><span style="color:#993300">＜ 映像 ＞</span></figcaption>' +
        '</figure>',
    );
  });

  it('applies the linkHref transform to links, buttons, and linked images', () => {
    const id = '63cb524a9f51b7858733e1108bf556fa';
    const detail = `https://hiroba.dqx.jp/sc/topics/detail/${id}/`;
    const out = renderBlocks(
      [
        {
          type: 'paragraph',
          children: [{ type: 'link', href: detail, children: ['前回の記事'] }],
        },
        { type: 'button', href: detail, children: ['詳細'] },
        { type: 'image', src: '/a.jpg', href: detail },
      ],
      { linkHref: rewriteArticleHref },
    );
    expect(out).toBe(
      `<p><a href="/topics/${id}">前回の記事</a></p>` +
        `<a class="rt-button" href="/topics/${id}">詳細</a>` +
        `<a class="rt-image-link" href="/topics/${id}"><img class="rt-image" src="/a.jpg" alt=""></a>`,
    );
  });

  it('applies the imageSrc transform when provided', () => {
    const out = renderBlocks(
      [{ type: 'image', src: 'https://cache.hiroba.dqx.jp/a.jpg' }],
      {
        imageSrc: (s) =>
          s.replace('https://cache.hiroba.dqx.jp', '/img/cache.hiroba.dqx.jp'),
      },
    );
    expect(out).toBe(
      '<img class="rt-image" src="/img/cache.hiroba.dqx.jp/a.jpg" alt="">',
    );
  });

  it('renders lists and tables', () => {
    expect(
      renderBlocks([
        {
          type: 'list',
          ordered: false,
          items: [{ children: ['a'] }, { children: ['b'] }],
        },
      ]),
    ).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(
      renderBlocks([
        {
          type: 'table',
          headers: [{ children: ['H'], header: true }],
          rows: [[{ children: ['c'], colSpan: 2 }]],
        },
      ]),
    ).toBe(
      '<table class="rt-table"><thead><tr><th>H</th></tr></thead><tbody><tr><td colspan="2">c</td></tr></tbody></table>',
    );
  });

  it('renders infoBox and accordion containers', () => {
    expect(
      renderBlocks([
        {
          type: 'infoBox',
          variant: 'highlight',
          children: [{ type: 'paragraph', children: ['hi'] }],
        },
      ]),
    ).toBe('<div class="rt-infobox" data-variant="highlight"><p>hi</p></div>');
    expect(
      renderBlocks([
        {
          type: 'accordion',
          summary: ['open'],
          children: [{ type: 'paragraph', children: ['x'] }],
        },
      ]),
    ).toBe(
      '<details class="rt-accordion"><summary>open</summary><p>x</p></details>',
    );
  });

  it('renders a toc infoBox as a semantic nav', () => {
    expect(
      renderBlocks([
        {
          type: 'infoBox',
          variant: 'toc',
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'strong', children: ['Index'] }],
            },
            {
              type: 'list',
              ordered: false,
              items: [
                { children: [{ type: 'link', href: '#a', children: ['A'] }] },
              ],
            },
          ],
        },
      ]),
    ).toBe(
      '<nav class="rt-toc" aria-label="Contents"><p><strong>Index</strong></p>' +
        '<ul><li><a href="#a">A</a></li></ul></nav>',
    );
  });

  it('renders a captioned image as a figure with a figcaption', () => {
    expect(
      renderBlocks([
        {
          type: 'image',
          src: 'https://cache.hiroba.dqx.jp/h.jpg',
          caption: [
            'See ',
            {
              type: 'link',
              href: 'https://hiroba.dqx.jp/x',
              children: ['here'],
            },
          ],
        },
      ]),
    ).toBe(
      '<figure class="rt-figure"><img class="rt-image" src="https://cache.hiroba.dqx.jp/h.jpg" alt="">' +
        '<figcaption class="rt-caption">See <a href="https://hiroba.dqx.jp/x">here</a></figcaption></figure>',
    );
  });

  it('wraps a linked captioned image as figure > a > img + figcaption', () => {
    expect(
      renderBlocks([
        {
          type: 'image',
          src: '/a.jpg',
          href: 'https://example.com/',
          external: true,
          caption: ['cap'],
        },
      ]),
    ).toBe(
      '<figure class="rt-figure"><a class="rt-image-link" href="https://example.com/" target="_blank" rel="noopener noreferrer">' +
        '<img class="rt-image" src="/a.jpg" alt=""></a>' +
        '<figcaption class="rt-caption">cap</figcaption></figure>',
    );
  });
});

describe('time/event inline rendering', () => {
  it('renders time as a semantic <time> with datetime', () => {
    expect(
      renderBlocks([
        {
          type: 'paragraph',
          children: [
            {
              type: 'time',
              datetime: '2026-07-13T05:59:00+09:00',
              children: ['7月13日 5:59'],
            },
          ],
        },
      ]),
    ).toBe(
      '<p><time class="rt-time" datetime="2026-07-13T05:59:00+09:00">7月13日 5:59</time></p>',
    );
  });

  it('renders event as a span with data-event-* attrs (end optional)', () => {
    expect(
      renderBlocks([
        {
          type: 'paragraph',
          children: [
            {
              type: 'event',
              id: 'ev_1',
              start: '2026-07-01T12:00:00+09:00',
              end: '2026-07-13T05:59:00+09:00',
              children: ['プレゼント期間'],
            },
            {
              type: 'event',
              id: 'ev_2',
              start: '2026-07-20',
              children: ['開始'],
            },
          ],
        },
      ]),
    ).toBe(
      '<p><span class="rt-event" data-event-id="ev_1" data-event-start="2026-07-01T12:00:00+09:00" data-event-end="2026-07-13T05:59:00+09:00">プレゼント期間</span>' +
        '<span class="rt-event" data-event-id="ev_2" data-event-start="2026-07-20">開始</span></p>',
    );
  });
});
