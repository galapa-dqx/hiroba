import { describe, expect, it } from 'vitest';

import { parseTopicBody } from './index';

describe('parseTopicBody — inline extraction', () => {
  it('nests bold + color and keeps text runs', () => {
    expect(parseTopicBody('<p>a<b>b</b><span style="color:#c03">c</span></p>')).toEqual([
      {
        type: 'paragraph',
        children: ['a', { type: 'strong', children: ['b'] }, { type: 'color', value: '#C03', children: ['c'] }],
      },
    ]);
  });

  it('distinguishes internal vs external links', () => {
    expect(parseTopicBody('<p><a href="/sc/x/">in</a><a href="http://e.com" target="_blank">out</a></p>')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'link', href: '/sc/x/', children: ['in'] },
          { type: 'link', href: 'http://e.com', external: true, children: ['out'] },
        ],
      },
    ]);
  });

  it('extracts the New badge and line breaks', () => {
    expect(parseTopicBody('<p>x<br><span class="ico_newsystem">New</span></p>')).toEqual([
      {
        type: 'paragraph',
        children: ['x', { type: 'break' }, { type: 'badge', text: 'New', variant: 'newsystem' }],
      },
    ]);
  });
});

describe('parseTopicBody — block extraction', () => {
  it('headings by tag and by class, with variants', () => {
    expect(parseTopicBody('<h2 class="title_quest">Q</h2>')).toEqual([{ type: 'heading', level: 2, children: ['Q'], variant: 'quest' }]);
    expect(parseTopicBody('<div class="title01">T</div>')).toEqual([{ type: 'heading', level: 1, children: ['T'] }]);
  });

  it('image-only paragraph → image block (src kept verbatim, not proxied)', () => {
    expect(parseTopicBody('<p><img src="/dq_resource/a.jpg" alt="cap"></p>')).toEqual([
      { type: 'image', src: '/dq_resource/a.jpg', alt: 'cap' },
    ]);
  });

  it('lineType1 → divider', () => {
    expect(parseTopicBody('<p class="lineType1"></p>')).toEqual([{ type: 'divider' }]);
  });

  it('a lone spacing <br> between blocks does not become a paragraph', () => {
    expect(parseTopicBody('<img src="/a.jpg"><br><img src="/b.jpg">')).toEqual([
      { type: 'image', src: '/a.jpg' },
      { type: 'image', src: '/b.jpg' },
    ]);
  });

  it('list items carry inline content, including links', () => {
    expect(parseTopicBody('<ul><li>a</li><li><a href="/y/">b</a></li></ul>')).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [{ children: ['a'] }, { children: [{ type: 'link', href: '/y/', children: ['b'] }] }],
      },
    ]);
  });

  it('caution list → list with caution variant', () => {
    expect(parseTopicBody('<div class="tp_caution"><ul><li>※ note</li></ul></div>')).toEqual([
      { type: 'list', ordered: false, variant: 'caution', items: [{ children: ['※ note'] }] },
    ]);
  });

  it('button unwraps its anchor', () => {
    expect(parseTopicBody('<div class="btn01"><a href="/z/">Go</a></div>')).toEqual([
      { type: 'button', href: '/z/', children: ['Go'] },
    ]);
  });

  it('infoBox recurses its content', () => {
    expect(parseTopicBody('<div class="brownroundBox"><p>hi</p></div>')).toEqual([
      { type: 'infoBox', variant: 'highlight', children: [{ type: 'paragraph', children: ['hi'] }] },
    ]);
  });

  it('youtube iframe → video block', () => {
    expect(parseTopicBody('<p><iframe src="https://www.youtube.com/embed/abc"></iframe></p>')).toEqual([
      { type: 'video', provider: 'youtube', src: 'https://www.youtube.com/embed/abc' },
    ]);
  });

  it('table: th cells marked as headers, colspan captured', () => {
    expect(parseTopicBody('<table class="contentsTable1"><tr><th>H</th></tr><tr><td colspan="2">c</td></tr></table>')).toEqual([
      {
        type: 'table',
        variant: 'contents',
        rows: [[{ children: ['H'], header: true }], [{ children: ['c'], colSpan: 2 }]],
      },
    ]);
  });
});
