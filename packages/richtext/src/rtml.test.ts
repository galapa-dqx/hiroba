import { describe, expect, it } from 'vitest';

import {
  parseRtml,
  parseTranslation,
  serializeForTranslation,
  serializeToRtml,
  type RtmlDocument,
} from './rtml';
import type { Block } from './schema';

/**
 * The core contract: `parseRtml(serializeToRtml(doc)) ≡ doc`.
 * Each fixture is a document in the canonical block model; a fixture that
 * round-trips proves both the serializer and the parser for the constructs it
 * exercises. (Fixtures are canonical — no adjacent bare-string text nodes, no
 * `x: false` for optional flags — matching what the source parser will emit.)
 */

const roundTrips = (label: string, doc: RtmlDocument) =>
  // eslint-disable-next-line vitest/valid-title -- label is a typed string param
  it(label, () => {
    const markup = serializeToRtml(doc);
    expect(parseRtml(markup)).toEqual(doc);
  });

const doc = (blocks: Block[], title = 'Title'): RtmlDocument => ({
  title,
  blocks,
});

describe('inline nodes', () => {
  roundTrips(
    'plain text',
    doc([{ type: 'paragraph', children: ['Hello world'] }]),
  );
  roundTrips(
    'break',
    doc([{ type: 'paragraph', children: ['a', { type: 'break' }, 'b'] }]),
  );
  roundTrips(
    'nested strong > color > text',
    doc([
      {
        type: 'paragraph',
        children: [
          {
            type: 'strong',
            children: [
              { type: 'color', value: '#CC0033', children: ['red bold'] },
            ],
          },
        ],
      },
    ]),
  );
  roundTrips(
    'emphasis',
    doc([
      {
        type: 'paragraph',
        children: [{ type: 'emphasis', children: ['italic'] }],
      },
    ]),
  );
  roundTrips(
    'link (internal + external)',
    doc([
      {
        type: 'paragraph',
        children: [
          { type: 'link', href: '/sc/topics/detail/x/', children: ['here'] },
          {
            type: 'link',
            href: 'https://example.com',
            external: true,
            children: ['there'],
          },
        ],
      },
    ]),
  );
  roundTrips(
    'badge (+variant) and icon (+alt)',
    doc([
      {
        type: 'paragraph',
        children: [
          { type: 'badge', text: 'New', variant: 'newsystem' },
          { type: 'badge', text: 'Plain' },
          { type: 'icon', src: '/dq_resource/ico_2nd.png', alt: '2nd' },
          { type: 'icon', src: '/dq_resource/ico.png' },
        ],
      },
    ]),
  );
  roundTrips(
    'time in a paragraph',
    doc([
      {
        type: 'paragraph',
        children: [
          '開催は',
          {
            type: 'time',
            datetime: '2026-07-13T05:59:00+09:00',
            children: ['2026年7月13日（月）5:59'],
          },
          'まで',
        ],
      },
    ]),
  );
  roundTrips(
    'event with and without end',
    doc([
      {
        type: 'paragraph',
        children: [
          {
            type: 'event',
            id: 'ev_abc123',
            start: '2026-07-01T12:00:00+09:00',
            end: '2026-07-13T05:59:00+09:00',
            children: ['プレゼント期間'],
          },
          {
            type: 'event',
            id: 'ev_def456',
            start: '2026-07-20',
            children: ['開始日'],
          },
        ],
      },
    ]),
  );
  roundTrips(
    'event containing time (canonical nesting)',
    doc([
      {
        type: 'paragraph',
        children: [
          {
            type: 'event',
            id: 'ev_abc123',
            start: '2026-07-01T12:00:00+09:00',
            end: '2026-07-13T05:59:00+09:00',
            children: [
              'プレゼント期間 ',
              {
                type: 'time',
                datetime: '2026-07-13T05:59:00+09:00',
                children: ['2026年7月13日（月）5:59'],
              },
              ' まで',
            ],
          },
        ],
      },
    ]),
  );
  roundTrips(
    'time/event nested under strong and inside table cell and list item',
    doc([
      {
        type: 'paragraph',
        children: [
          {
            type: 'strong',
            children: [
              {
                type: 'time',
                datetime: '2026-08-01T20:00:00+09:00',
                children: ['8月1日 20:00'],
              },
            ],
          },
        ],
      },
      {
        type: 'table',
        rows: [
          [
            {
              children: [
                {
                  type: 'event',
                  id: 'ev_t1',
                  start: '2026-08-01',
                  end: '2026-08-03',
                  children: ['開催期間'],
                },
              ],
            },
          ],
        ],
      },
      {
        type: 'list',
        ordered: false,
        items: [
          {
            children: [
              {
                type: 'time',
                datetime: '2026-08-03',
                children: ['8月3日'],
              },
            ],
          },
        ],
      },
    ]),
  );
});

describe('text blocks', () => {
  roundTrips(
    'paragraph align',
    doc([{ type: 'paragraph', align: 'center', children: ['centered'] }]),
  );
  roundTrips(
    'headings all levels + variant',
    doc([
      { type: 'heading', level: 1, children: ['H1'] },
      { type: 'heading', level: 2, children: ['H2'], variant: 'quest' },
      { type: 'heading', level: 3, children: ['H3'], variant: 'icon' },
      { type: 'heading', level: 4, children: ['H4'], variant: 'label' },
    ]),
  );
  roundTrips(
    'heading with an anchor id (and with variant)',
    doc([
      { type: 'heading', level: 2, children: ['Section'], anchor: 'dra' },
      {
        type: 'heading',
        level: 3,
        children: ['Q'],
        variant: 'quest',
        anchor: 'q1',
      },
    ]),
  );
  roundTrips(
    'button (+variant)',
    doc([
      { type: 'button', href: '/go/', children: ['Go'] },
      { type: 'button', href: '/go2/', children: ['Go'], variant: 'vt2013' },
    ]),
  );
  roundTrips('divider', doc([{ type: 'divider' }]));
});

describe('media blocks', () => {
  roundTrips(
    'image minimal',
    doc([{ type: 'image', src: 'https://cache.hiroba.dqx.jp/a.jpg' }]),
  );
  roundTrips(
    'image with alt/variant/sources',
    doc([
      {
        type: 'image',
        src: '/dq_resource/a.jpg',
        alt: 'caption',
        variant: 'newsImage',
        sources: [
          { src: '/dq_resource/a-1920.jpg', minWidth: 1920 },
          { src: '/dq_resource/a-1280.jpg' },
        ],
      },
    ]),
  );
  roundTrips(
    'image with baked-in text serializes as <figure> with <line> spans',
    doc([
      {
        type: 'image',
        src: '/dq_resource/banner.jpg',
        variant: 'newsImage',
        text: ['夏の大型アップデート', '開催決定！'],
      },
    ]),
  );
  roundTrips(
    'linked image (internal)',
    doc([
      { type: 'image', src: '/a.jpg', href: 'https://hiroba.dqx.jp/sc/x/' },
    ]),
  );
  roundTrips(
    'linked external image with baked-in text',
    doc([
      {
        type: 'image',
        src: '/a.jpg',
        href: 'https://example.com/',
        external: true,
        text: ['Click here!'],
      },
    ]),
  );
  roundTrips(
    'image with a caption (keeps the caption’s inline link)',
    doc([
      {
        type: 'image',
        src: '/dq_resource/house.jpg',
        caption: [
          '2番地は',
          {
            type: 'link',
            href: 'https://hiroba.dqx.jp/sc/shop/',
            children: ['ホテル風'],
          },
          'ハウジングです！',
        ],
      },
    ]),
  );
  roundTrips(
    'image carrying both baked-in text and a caption',
    doc([
      {
        type: 'image',
        src: '/dq_resource/banner.jpg',
        text: ['開催決定！'],
        caption: [{ type: 'color', value: '#FF0000', children: ['※注意'] }],
      },
    ]),
  );

  it('serializes image text as one <line> per span', () => {
    expect(
      serializeToRtml(
        doc(
          [{ type: 'image', src: '/a.jpg', text: ['Line one', 'Line two'] }],
          '',
        ),
      ),
    ).toBe(
      '<doctitle></doctitle><figure src="/a.jpg"><line>Line one</line><line>Line two</line></figure>',
    );
  });
  it('serializes a caption as a <figcaption> after the <line> spans', () => {
    expect(
      serializeToRtml(
        doc(
          [
            {
              type: 'image',
              src: '/a.jpg',
              text: ['Baked'],
              caption: ['A caption'],
            },
          ],
          '',
        ),
      ),
    ).toBe(
      '<doctitle></doctitle><figure src="/a.jpg"><line>Baked</line><figcaption>A caption</figcaption></figure>',
    );
  });
  roundTrips(
    'video',
    doc([
      {
        type: 'video',
        provider: 'youtube',
        src: 'https://youtube.com/embed/x',
      },
    ]),
  );
  roundTrips(
    'video with a caption (keeps the caption’s color run)',
    doc([
      {
        type: 'video',
        provider: 'youtube',
        src: 'https://youtube.com/embed/x',
        caption: [
          {
            type: 'color',
            value: '#993300',
            children: ['＜ ゼネシアトランプ ＞'],
          },
        ],
      },
    ]),
  );
  it('serializes a video caption as a <figcaption> child', () => {
    expect(
      serializeToRtml(
        doc(
          [
            {
              type: 'video',
              provider: 'youtube',
              src: 'https://youtube.com/embed/x',
              caption: ['A caption'],
            },
          ],
          '',
        ),
      ),
    ).toBe(
      '<doctitle></doctitle><video provider="youtube" src="https://youtube.com/embed/x"><figcaption>A caption</figcaption></video>',
    );
  });
  roundTrips(
    'embed variants',
    doc([
      { type: 'embed', provider: 'twitter', variant: 'button' },
      {
        type: 'embed',
        provider: 'twitter',
        variant: 'hashtag',
        content: '#DQX10th',
      },
    ]),
  );
});

describe('container blocks', () => {
  roundTrips(
    'infoBox with mixed + nested content',
    doc([
      {
        type: 'infoBox',
        variant: 'highlight',
        children: [
          { type: 'paragraph', children: ['line'] },
          'bare inline text',
          {
            type: 'infoBox',
            variant: 'mini',
            children: [{ type: 'paragraph', children: ['nested'] }],
          },
        ],
      },
    ]),
  );
  roundTrips(
    'toc infoBox (title + list of anchor links)',
    doc([
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
              { children: [{ type: 'link', href: '#b', children: ['B'] }] },
            ],
          },
        ],
      },
    ]),
  );
  roundTrips(
    'section with title + dateline',
    doc([
      {
        type: 'section',
        variant: 'newspaper',
        title: [{ type: 'strong', children: ['アストルティア通信'] }],
        dateline: ['2014年5月27日 発行'],
        children: [{ type: 'paragraph', children: ['body'] }],
      },
    ]),
  );
  roundTrips(
    'accordion',
    doc([
      {
        type: 'accordion',
        summary: ['Open me', { type: 'badge', text: 'New' }],
        children: [{ type: 'paragraph', children: ['hidden'] }],
      },
    ]),
  );
  roundTrips(
    'speechBubble',
    doc([
      {
        type: 'speechBubble',
        speaker: 'ラベンタ',
        icon: '/dq_resource/npc.png',
        children: [{ type: 'paragraph', children: ['hi'] }],
      },
      {
        type: 'speechBubble',
        children: [{ type: 'paragraph', children: ['anon'] }],
      },
    ]),
  );
  roundTrips(
    'messageBox',
    doc([
      {
        type: 'messageBox',
        name: '山田',
        role: 'ディレクター',
        children: [{ type: 'paragraph', children: ['msg'] }],
      },
      {
        type: 'messageBox',
        children: [{ type: 'paragraph', children: ['msg'] }],
      },
    ]),
  );
});

describe('structured blocks', () => {
  roundTrips(
    'list ordered/unordered + caution',
    doc([
      {
        type: 'list',
        ordered: false,
        items: [{ children: ['a'] }, { children: ['b'] }],
      },
      {
        type: 'list',
        ordered: true,
        items: [{ children: [{ type: 'paragraph', children: ['step'] }] }],
      },
      {
        type: 'list',
        ordered: false,
        variant: 'caution',
        items: [{ children: ['※ note'] }],
      },
    ]),
  );
  roundTrips(
    'table with headers, spans, header cells',
    doc([
      {
        type: 'table',
        variant: 'contents',
        headers: [
          { children: ['Name'], header: true },
          { children: ['Value'], header: true },
        ],
        rows: [
          [{ children: ['row header'], header: true }, { children: ['x'] }],
          [{ children: ['span'], colSpan: 2, rowSpan: 2 }],
        ],
      },
    ]),
  );
  roundTrips(
    'table without headers',
    doc([
      { type: 'table', rows: [[{ children: ['a'] }, { children: ['b'] }]] },
    ]),
  );
  roundTrips(
    'interview',
    doc([
      {
        type: 'interview',
        title: '開発者インタビュー',
        writer: '編集部',
        exchanges: [
          {
            question: ['What is new?', { type: 'break' }],
            answer: [
              { type: 'paragraph', children: ['A lot.'] },
              { type: 'paragraph', children: ['Really.'] },
            ],
          },
        ],
      },
    ]),
  );
  roundTrips(
    'steps',
    doc([
      {
        type: 'steps',
        variant: 'howto',
        items: [
          { n: 1, children: [{ type: 'paragraph', children: ['first'] }] },
          { children: [{ type: 'paragraph', children: ['unnumbered'] }] },
        ],
      },
    ]),
  );
  roundTrips(
    'ranking',
    doc([
      {
        type: 'ranking',
        variant: 'area',
        items: [
          { rank: 1, title: ['Slime'], count: '1,234' },
          { rank: 2, title: [{ type: 'strong', children: ['Dracky'] }] },
        ],
      },
    ]),
  );
});

describe('escaping & whitespace', () => {
  roundTrips(
    'special chars in text',
    doc(
      [{ type: 'paragraph', children: ['A & B < C > D "quoted" & more'] }],
      'Title & <tag>',
    ),
  );
  roundTrips(
    'ampersand in href and color value',
    doc([
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            href: 'https://x.test/?a=1&b=2',
            children: [{ type: 'color', value: '#333', children: ['x'] }],
          },
        ],
      },
    ]),
  );
  roundTrips(
    'multiline text preserved',
    doc([{ type: 'paragraph', children: ['line1\nline2\n  indented'] }]),
  );
});

describe('full document', () => {
  roundTrips(
    'a representative topic',
    doc(
      [
        {
          type: 'image',
          src: 'https://cache.hiroba.dqx.jp/dq_resource/imgs/banner.jpg',
        },
        {
          type: 'heading',
          level: 2,
          children: ['ショップポイントを受けとってみよう！'],
        },
        {
          type: 'infoBox',
          variant: 'highlight',
          children: [
            {
              type: 'paragraph',
              children: [
                '毎月 ',
                {
                  type: 'strong',
                  children: [
                    {
                      type: 'color',
                      value: '#CC0033',
                      children: ['メギストリスの都'],
                    },
                  ],
                },
                ' に登場！ 詳しくは ',
                {
                  type: 'link',
                  href: '/sc/topics/detail/x/',
                  children: ['こちら'],
                },
                { type: 'badge', text: 'New', variant: 'newsystem' },
              ],
            },
          ],
        },
        { type: 'divider' },
        {
          type: 'list',
          ordered: false,
          variant: 'caution',
          items: [{ children: ['※ 1回のみ受け取れます。'] }],
        },
        {
          type: 'button',
          href: '/sc/shop/',
          children: ['ショップへ'],
          variant: 'square',
        },
      ],
      'ショップポイント配布のお知らせ',
    ),
  );
});

describe('parse robustness', () => {
  it('empty document', () => {
    expect(parseRtml(serializeToRtml({ title: '', blocks: [] }))).toEqual({
      title: '',
      blocks: [],
    });
  });
});

/**
 * Translation wire format — `<title>…</title><article>…</article>` sent to the
 * LLM so it sees title + body together. Round-trips like the core RTML format.
 */
describe('translation wire format', () => {
  const trips = (label: string, d: RtmlDocument) =>
    // eslint-disable-next-line vitest/valid-title -- label is a typed string param
    it(label, () =>
      expect(parseTranslation(serializeForTranslation(d))).toEqual(d),
    );

  trips(
    'title + body with inline formatting',
    doc(
      [
        { type: 'heading', level: 2, children: ['見出し'] },
        {
          type: 'paragraph',
          children: [
            '本文 ',
            {
              type: 'strong',
              children: [
                { type: 'color', value: '#CC0033', children: ['赤字'] },
              ],
            },
          ],
        },
        {
          type: 'list',
          ordered: false,
          variant: 'caution',
          items: [{ children: ['※ 注意'] }],
        },
      ],
      'お知らせ',
    ),
  );
  trips(
    'title with special characters',
    doc([{ type: 'paragraph', children: ['x'] }], 'A & B <tag> "q"'),
  );
  trips('empty body', doc([], 'Just a title'));

  it('emits the title as <title> and the body inside <article>', () => {
    const markup = serializeForTranslation(
      doc([{ type: 'paragraph', children: ['hi'] }], 'T'),
    );
    expect(markup).toBe('<title>T</title><article><p>hi</p></article>');
  });
});

/**
 * Translation tolerance — the model sometimes invents a tag outside the
 * vocabulary (`<sword>`) or un-escapes a source angle-bracket into live markup.
 * Unlike parseRtml, parseTranslation must not throw the whole body away: it
 * unwraps the unknown tag to its text/children and parses the rest.
 */
describe('translation tolerance (unknown tags unwrapped)', () => {
  it('unwraps an invented inline tag to its text, keeping the paragraph', () => {
    const markup =
      '<title>T</title><article><p>The <sword>Sacred Blade</sword> returns</p></article>';
    expect(parseTranslation(markup)).toEqual(
      doc(
        [
          {
            type: 'paragraph',
            children: ['The ', 'Sacred Blade', ' returns'],
          },
        ],
        'T',
      ),
    );
  });

  it('keeps the known children of an unwrapped tag', () => {
    const markup =
      '<title>T</title><article><p>a<foo><strong>bold</strong></foo>b</p></article>';
    expect(parseTranslation(markup)).toEqual(
      doc(
        [
          {
            type: 'paragraph',
            children: ['a', { type: 'strong', children: ['bold'] }, 'b'],
          },
        ],
        'T',
      ),
    );
  });

  it('lifts real blocks out of an unknown block-level wrapper', () => {
    const markup =
      '<title>T</title><article><wrapper><p>one</p><p>two</p></wrapper></article>';
    expect(parseTranslation(markup)).toEqual(
      doc(
        [
          { type: 'paragraph', children: ['one'] },
          { type: 'paragraph', children: ['two'] },
        ],
        'T',
      ),
    );
  });

  it('drops a self-closed unknown tag entirely', () => {
    const markup = '<title>T</title><article><p>a<sparkle/>b</p></article>';
    expect(parseTranslation(markup)).toEqual(
      doc([{ type: 'paragraph', children: ['a', 'b'] }], 'T'),
    );
  });

  it('does not disturb structural tags nested inside a real block', () => {
    const markup =
      '<title>T</title><article><table><tbody><tr><td>x<bogus>y</bogus></td></tr></tbody></table></article>';
    expect(parseTranslation(markup)).toEqual(
      doc([{ type: 'table', rows: [[{ children: ['x', 'y'] }]] }], 'T'),
    );
  });

  // Drift guard: a document exercising the container/structural vocabulary must
  // still round-trip through parseTranslation. If a real tag were missing from
  // KNOWN_TAGS it would be unwrapped here and the structure would break.
  it('leaves a rich document with structural tags intact through the unwrap pass', () => {
    const rich = doc(
      [
        {
          type: 'section',
          variant: 'newspaper',
          title: [{ type: 'strong', children: ['見出し'] }],
          dateline: ['2026年7月5日 発行'],
          children: [{ type: 'paragraph', children: ['本文'] }],
        },
        {
          type: 'image',
          src: '/a.jpg',
          text: ['行1', '行2'],
          caption: ['説明'],
        },
        {
          type: 'table',
          headers: [{ children: ['見出し'], header: true }],
          rows: [[{ children: ['値'] }]],
        },
        {
          type: 'list',
          ordered: false,
          items: [{ children: ['項目'] }],
        },
        {
          type: 'interview',
          title: 'インタビュー',
          writer: '編集部',
          exchanges: [
            {
              question: ['質問'],
              answer: [{ type: 'paragraph', children: ['回答'] }],
            },
          ],
        },
        {
          type: 'steps',
          items: [
            { n: 1, children: [{ type: 'paragraph', children: ['手順'] }] },
          ],
        },
        {
          type: 'ranking',
          items: [{ rank: 1, title: ['一位'], count: '100' }],
        },
        {
          type: 'accordion',
          summary: ['開く'],
          children: [{ type: 'paragraph', children: ['中身'] }],
        },
        {
          type: 'speechBubble',
          speaker: '話者',
          children: [{ type: 'paragraph', children: ['やあ'] }],
        },
        {
          type: 'messageBox',
          name: '名前',
          role: '役職',
          children: [{ type: 'paragraph', children: ['伝言'] }],
        },
      ],
      'タイトル',
    );
    expect(parseTranslation(serializeForTranslation(rich))).toEqual(rich);
  });
});

/**
 * Print goldens — pin the exact wire format, so an accidental change to the
 * vocabulary or escaping is caught (round-trip tests alone wouldn't notice a
 * format that changed but still parsed back consistently).
 */
describe('print (exact serialization)', () => {
  const golden = (label: string, doc: RtmlDocument, expected: string) =>
    // eslint-disable-next-line vitest/valid-title -- label is a typed string param
    it(label, () => expect(serializeToRtml(doc)).toBe(expected));

  golden(
    'paragraph',
    doc([{ type: 'paragraph', children: ['Hi'] }], 'T'),
    '<doctitle>T</doctitle><p>Hi</p>',
  );
  golden(
    'nested inline',
    doc(
      [
        {
          type: 'paragraph',
          children: [
            {
              type: 'strong',
              children: [{ type: 'color', value: '#c03', children: ['red'] }],
            },
          ],
        },
      ],
      'T',
    ),
    '<doctitle>T</doctitle><p><strong><color value="#c03">red</color></strong></p>',
  );
  golden(
    'external link is a boolean attribute',
    doc(
      [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              href: 'https://x',
              external: true,
              children: ['go'],
            },
          ],
        },
      ],
      'T',
    ),
    '<doctitle>T</doctitle><p><a href="https://x" external>go</a></p>',
  );
  golden(
    'text and attribute escaping',
    doc(
      [
        {
          type: 'paragraph',
          children: [
            'A & B <x>',
            { type: 'link', href: 'u?a=1&b=2', children: ['"q"'] },
          ],
        },
      ],
      'T & U',
    ),
    // Quotes are escaped only in attribute values, not in text content.
    '<doctitle>T &amp; U</doctitle><p>A &amp; B &lt;x&gt;<a href="u?a=1&amp;b=2">"q"</a></p>',
  );
  golden(
    'table structure (thead/tbody, no injected attrs)',
    doc(
      [
        {
          type: 'table',
          headers: [{ children: ['H'], header: true }],
          rows: [[{ children: ['c'] }]],
        },
      ],
      'T',
    ),
    '<doctitle>T</doctitle><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>',
  );
  golden(
    'image sources ride a JSON attribute',
    doc(
      [
        {
          type: 'image',
          src: '/a.jpg',
          sources: [{ src: '/b.jpg', minWidth: 1920 }],
        },
      ],
      'T',
    ),
    '<doctitle>T</doctitle><img src="/a.jpg" sources="[{&quot;src&quot;:&quot;/b.jpg&quot;,&quot;minWidth&quot;:1920}]">',
  );
});

/**
 * Parse tolerance — the model won't emit byte-identical RTML. Parsing must
 * absorb the shapes an LLM realistically produces without corrupting the tree.
 */
describe('parse tolerance (LLM-shaped input)', () => {
  it('drops formatting whitespace between block elements', () => {
    const markup =
      '<doctitle>T</doctitle><infobox variant="highlight">\n  <p>hi</p>\n  <p>bye</p>\n</infobox>';
    expect(parseRtml(markup)).toEqual(
      doc(
        [
          {
            type: 'infoBox',
            variant: 'highlight',
            children: [
              { type: 'paragraph', children: ['hi'] },
              { type: 'paragraph', children: ['bye'] },
            ],
          },
        ],
        'T',
      ),
    );
  });

  it('accepts self-closed atoms without swallowing siblings', () => {
    const markup = '<doctitle></doctitle><p>a<icon src="i.png"/>b<br/>c</p>';
    expect(parseRtml(markup)).toEqual(
      doc(
        [
          {
            type: 'paragraph',
            children: [
              'a',
              { type: 'icon', src: 'i.png' },
              'b',
              { type: 'break' },
              'c',
            ],
          },
        ],
        '',
      ),
    );
  });

  it('decodes entities on parse', () => {
    expect(parseRtml('<doctitle>A &amp; B</doctitle><p>x &lt; y</p>')).toEqual(
      doc([{ type: 'paragraph', children: ['x < y'] }], 'A & B'),
    );
  });

  it('ignores unknown attributes on known tags', () => {
    expect(
      parseRtml('<doctitle></doctitle><p class="foo" data-x="1">hi</p>'),
    ).toEqual(doc([{ type: 'paragraph', children: ['hi'] }], ''));
  });

  it('ignores stray text at the top level', () => {
    expect(parseRtml('<doctitle>T</doctitle>  \n  <p>x</p>')).toEqual(
      doc([{ type: 'paragraph', children: ['x'] }], 'T'),
    );
  });

  it('throws on an unknown tag (so the pipeline falls back to JA)', () => {
    expect(() => parseRtml('<doctitle></doctitle><bogus>x</bogus>')).toThrow(
      /unknown block tag/i,
    );
  });
});
