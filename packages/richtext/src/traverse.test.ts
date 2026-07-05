import { describe, expect, it } from 'vitest';

import type { Block, ContentNode } from './schema';
import { childrenOf, mapChildren, mapNodes, walk } from './traverse';

/**
 * A document exercising every container shape, with a unique string leaf
 * planted in every child slot. If mapChildren forgets a slot, the walk
 * misses its marker and the coverage test fails.
 */
const kitchenSink = (): Block[] => [
  { type: 'paragraph', align: 'center', children: ['p'] },
  { type: 'heading', level: 2, anchor: 'a1', children: ['h'] },
  { type: 'button', href: '#', children: ['btn'] },
  { type: 'divider' },
  {
    type: 'image',
    src: 'img.jpg',
    sources: [{ src: 'img@2x.jpg' }],
    text: ['baked'],
    caption: [
      'cap ',
      { type: 'link', href: '#c', children: ['caplink'] },
      { type: 'icon', src: 'capicon.gif' },
    ],
  },
  { type: 'video', provider: 'youtube', src: 'v' },
  { type: 'embed', provider: 'twitter', content: 'tw' },
  {
    type: 'infoBox',
    variant: 'highlight',
    children: ['ib', { type: 'paragraph', children: ['ibp'] }],
  },
  {
    type: 'section',
    title: ['st'],
    dateline: ['sd'],
    children: [{ type: 'paragraph', children: ['sc'] }],
  },
  {
    type: 'accordion',
    summary: ['as'],
    children: [{ type: 'paragraph', children: ['ac'] }],
  },
  {
    type: 'speechBubble',
    icon: 'face.jpg',
    children: [{ type: 'paragraph', children: ['sp'] }],
  },
  { type: 'messageBox', children: ['mb'] },
  {
    type: 'list',
    ordered: false,
    items: [{ children: ['li1'] }, { children: ['li2'] }],
  },
  {
    type: 'table',
    headers: [{ children: ['th'], header: true }],
    rows: [[{ children: ['td1'] }, { children: ['td2'] }]],
  },
  {
    type: 'interview',
    exchanges: [
      { question: ['q'], answer: [{ type: 'paragraph', children: ['ans'] }] },
    ],
  },
  {
    type: 'steps',
    items: [{ n: 1, children: [{ type: 'paragraph', children: ['step'] }] }],
  },
  { type: 'ranking', items: [{ rank: 1, title: ['rk'] }] },
  {
    type: 'paragraph',
    children: [
      { type: 'strong', children: ['b'] },
      { type: 'emphasis', children: ['i'] },
      { type: 'color', value: '#C03', children: ['col'] },
      { type: 'break' },
      { type: 'badge', text: 'New' },
    ],
  },
];

/** Every string leaf the tree holds, one marker per child slot. */
const ALL_LEAVES = [
  'p',
  'h',
  'btn',
  'cap ',
  'caplink',
  'ib',
  'ibp',
  'st',
  'sd',
  'sc',
  'as',
  'ac',
  'sp',
  'mb',
  'li1',
  'li2',
  'th',
  'td1',
  'td2',
  'q',
  'ans',
  'step',
  'rk',
  'b',
  'i',
  'col',
];

describe('walk', () => {
  it('reaches the string leaf in every child slot of every container', () => {
    const seen: string[] = [];
    walk(kitchenSink(), (n) => {
      if (typeof n === 'string') seen.push(n);
    });
    expect(seen).toEqual(ALL_LEAVES);
  });

  it('visits pre-order in document order (parent before children, slots in serialization order)', () => {
    const order: string[] = [];
    walk(
      [
        {
          type: 'section',
          title: ['t'],
          dateline: ['d'],
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'strong', children: ['s'] }],
            },
          ],
        },
      ],
      (n) => order.push(typeof n === 'string' ? n : n.type),
    );
    expect(order).toEqual(['section', 't', 'd', 'paragraph', 'strong', 's']);
  });

  it('visits table headers before body rows', () => {
    const order: string[] = [];
    walk(
      [
        {
          type: 'table',
          headers: [{ children: ['h'] }],
          rows: [[{ children: ['r'] }]],
        },
      ],
      (n) => {
        if (typeof n === 'string') order.push(n);
      },
    );
    expect(order).toEqual(['h', 'r']);
  });

  it('visits the live nodes (collected references can be hydrated in place)', () => {
    const blocks: Block[] = [
      {
        type: 'infoBox',
        variant: 'mini',
        children: [{ type: 'image', src: 'a.jpg' }],
      },
    ];
    walk(blocks, (n) => {
      if (typeof n !== 'string' && n.type === 'image') n.alt = 'hydrated';
    });
    const box = blocks[0];
    expect(box.type === 'infoBox' && box.children[0]).toMatchObject({
      alt: 'hydrated',
    });
  });
});

describe('childrenOf', () => {
  it('returns no children for text and atoms', () => {
    expect(childrenOf('txt')).toEqual([]);
    expect(childrenOf({ type: 'break' })).toEqual([]);
    expect(childrenOf({ type: 'divider' })).toEqual([]);
    expect(childrenOf({ type: 'badge', text: 'New' })).toEqual([]);
    expect(childrenOf({ type: 'image', src: 'a.jpg' })).toEqual([]);
  });

  it('flattens multi-slot containers in document order', () => {
    const children = childrenOf({
      type: 'interview',
      exchanges: [
        {
          question: ['q1'],
          answer: [{ type: 'paragraph', children: ['a1'] }],
        },
        { question: ['q2'], answer: [] },
      ],
    });
    expect(children).toEqual([
      'q1',
      { type: 'paragraph', children: ['a1'] },
      'q2',
    ]);
  });
});

describe('mapChildren', () => {
  it('rebuilds every slot through the transform', () => {
    const upcase = (list: ContentNode[]): ContentNode[] =>
      list.map((n) => (typeof n === 'string' ? n.toUpperCase() : n));
    expect(
      mapChildren(
        {
          type: 'accordion',
          summary: ['s'],
          children: ['c'],
        },
        upcase,
      ),
    ).toEqual({ type: 'accordion', summary: ['S'], children: ['C'] });
  });

  it('keeps absent optional slots absent', () => {
    const table = mapChildren(
      { type: 'table', rows: [[{ children: ['x'] }]] },
      (l) => l,
    );
    expect('headers' in table).toBe(false);
    const section = mapChildren({ type: 'section', children: [] }, (l) => l);
    expect('title' in section).toBe(false);
    expect('dateline' in section).toBe(false);
  });
});

describe('mapNodes', () => {
  it('rewrites matching nodes everywhere without touching structure (URL-rewrite shape)', () => {
    const blocks = kitchenSink();
    const out = mapNodes(blocks, (n) => {
      if (typeof n === 'string') return n;
      if (n.type === 'image') return { ...n, src: `/img/${n.src}` };
      if (n.type === 'icon') return { ...n, src: `/img/${n.src}` };
      return n;
    });

    const srcs: string[] = [];
    walk(out, (n) => {
      if (typeof n !== 'string' && (n.type === 'image' || n.type === 'icon'))
        srcs.push(n.src);
    });
    expect(srcs).toEqual(['/img/img.jpg', '/img/capicon.gif']);
    // Input tree untouched.
    const inSrcs: string[] = [];
    walk(blocks, (n) => {
      if (typeof n !== 'string' && (n.type === 'image' || n.type === 'icon'))
        inSrcs.push(n.src);
    });
    expect(inSrcs).toEqual(['img.jpg', 'capicon.gif']);
  });

  it('is an identity when the transform is', () => {
    const blocks = kitchenSink();
    expect(mapNodes(blocks, (n) => n)).toEqual(blocks);
  });

  it('transforms parents before children and descends into the returned node', () => {
    const out = mapNodes([{ type: 'paragraph', children: ['keep'] }], (n) => {
      if (typeof n === 'string') return n.toUpperCase();
      if (n.type === 'paragraph')
        return { ...n, children: [...n.children, ' added'] };
      return n;
    });
    // The child appended by the parent's transform is itself transformed.
    expect(out).toEqual([{ type: 'paragraph', children: ['KEEP', ' ADDED'] }]);
  });
});
