import { describe, expect, it } from 'vitest';

import { parseTopicBody } from './index';

const CDN = 'https://hiroba.dqx.jp';

describe('parseTopicBody — inline extraction', () => {
  it('nests bold + color and keeps text runs', () => {
    expect(
      parseTopicBody('<p>a<b>b</b><span style="color:#c03">c</span></p>'),
    ).toEqual([
      {
        type: 'paragraph',
        children: [
          'a',
          { type: 'strong', children: ['b'] },
          { type: 'color', value: '#C03', children: ['c'] },
        ],
      },
    ]);
  });

  it('absolutizes hrefs and detects off-site links by host', () => {
    expect(
      parseTopicBody(
        '<p><a href="/sc/x/">in</a><a href="http://e.com" target="_blank">out</a></p>',
      ),
    ).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'link', href: `${CDN}/sc/x/`, children: ['in'] },
          {
            type: 'link',
            href: 'http://e.com',
            external: true,
            children: ['out'],
          },
        ],
      },
    ]);
  });

  it('extracts the New badge and line breaks', () => {
    expect(
      parseTopicBody('<p>x<br><span class="ico_newsystem">New</span></p>'),
    ).toEqual([
      {
        type: 'paragraph',
        children: [
          'x',
          { type: 'break' },
          { type: 'badge', text: 'New', variant: 'newsystem' },
        ],
      },
    ]);
    // ico_checkmark (common on TOC entries) becomes a Check badge too
    expect(
      parseTopicBody('<p><span class="ico_checkmark">Check</span></p>'),
    ).toEqual([
      {
        type: 'paragraph',
        children: [{ type: 'badge', text: 'Check', variant: 'checkmark' }],
      },
    ]);
  });

  it('turns expansion-pack ordinal / Suggestion Box sprite spans into badges', () => {
    // The sprite-span form (`<span class="ico_8th">8th</span>`, glyph via CSS
    // background) keeps its label as a chip — distinct from the <img class="img_2nd">
    // form above, which stays an inline image node.
    expect(
      parseTopicBody(
        '<p><span class="ico_8th">8th</span>を導入' +
          '<span class="ico_teian">提案広場</span></p>',
      ),
    ).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'badge', text: '8th', variant: '8th' },
          'を導入',
          { type: 'badge', text: '提案広場', variant: 'teian' },
        ],
      },
    ]);
    // A glyph-only span (no inner text) falls back to a readable label.
    expect(
      parseTopicBody('<p>対応：<span class="ico_3ds"></span></p>'),
    ).toEqual([
      {
        type: 'paragraph',
        children: ['対応：', { type: 'badge', text: '3DS', variant: '3ds' }],
      },
    ]);
  });

  it('keeps a small ordinal/platform icon inline (and absolutizes its src)', () => {
    expect(
      parseTopicBody(
        '<p>Rank <img class="img_2nd" src="/dq_resource/img/common/ico_2nd.gif" alt="2nd"></p>',
      ),
    ).toEqual([
      {
        type: 'paragraph',
        children: [
          'Rank ',
          {
            type: 'icon',
            src: `${CDN}/dq_resource/img/common/ico_2nd.gif`,
            alt: '2nd',
          },
        ],
      },
    ]);
  });
});

describe('parseTopicBody — block extraction', () => {
  it('headings by tag and by class, with variants', () => {
    expect(parseTopicBody('<h2 class="title_quest">Q</h2>')).toEqual([
      { type: 'heading', level: 2, children: ['Q'], variant: 'quest' },
    ]);
    expect(parseTopicBody('<div class="title01">T</div>')).toEqual([
      { type: 'heading', level: 1, children: ['T'] },
    ]);
  });

  it('trims decorative edge U+3000 on headings but keeps it as a mid-text separator', () => {
    // leading + trailing ideographic space (source indentation) is stripped
    expect(
      parseTopicBody('<h2 class="title02">　公開中のハウジング　</h2>'),
    ).toEqual([
      { type: 'heading', level: 2, children: ['公開中のハウジング'] },
    ]);
    // a meaningful mid-text ideographic space is preserved
    expect(
      parseTopicBody(
        '<h4 class="title_icon01">　デイジー地区　マイタウンID</h4>',
      ),
    ).toEqual([
      {
        type: 'heading',
        level: 4,
        children: ['デイジー地区　マイタウンID'],
        variant: 'icon',
      },
    ]);
  });

  it('a full content image is a block image, splitting the paragraph (src absolutized)', () => {
    expect(
      parseTopicBody(
        '<p>See this: <img src="/dq_resource/imgs/TopicsImages/x.jpg" alt="cap"></p>',
      ),
    ).toEqual([
      { type: 'paragraph', children: ['See this:'] },
      {
        type: 'image',
        src: `${CDN}/dq_resource/imgs/TopicsImages/x.jpg`,
        alt: 'cap',
      },
    ]);
  });

  it('content image inside a <center>/<div> wrapper becomes a block image', () => {
    // Mirrors the real markup: brownroundBox > <center> > text + <div align><img>.
    expect(
      parseTopicBody(
        '<center>Hello <b>there</b><div align="center"><img src="/dq_resource/imgs/TopicsImages/x.jpg"></div></center>',
      ),
    ).toEqual([
      {
        type: 'paragraph',
        children: ['Hello ', { type: 'strong', children: ['there'] }],
      },
      { type: 'image', src: `${CDN}/dq_resource/imgs/TopicsImages/x.jpg` },
    ]);
  });

  it('a link wrapping a full image → block image carrying the href', () => {
    expect(
      parseTopicBody(
        '<a href="/sc/campaign/"><img src="/dq_resource/imgs/TopicsImages/y.jpg"></a>',
      ),
    ).toEqual([
      {
        type: 'image',
        src: `${CDN}/dq_resource/imgs/TopicsImages/y.jpg`,
        href: `${CDN}/sc/campaign/`,
      },
    ]);
    // off-site link marks the image external
    expect(
      parseTopicBody(
        '<a href="https://x.com/"><img src="/dq_resource/imgs/TopicsImages/z.jpg"></a>',
      ),
    ).toEqual([
      {
        type: 'image',
        src: `${CDN}/dq_resource/imgs/TopicsImages/z.jpg`,
        href: 'https://x.com/',
        external: true,
      },
    ]);
  });

  it('image-only paragraph → image block', () => {
    expect(
      parseTopicBody('<p><img src="/dq_resource/a.jpg" alt="cap"></p>'),
    ).toEqual([{ type: 'image', src: `${CDN}/dq_resource/a.jpg`, alt: 'cap' }]);
  });

  it('lineType1 → divider', () => {
    expect(parseTopicBody('<p class="lineType1"></p>')).toEqual([
      { type: 'divider' },
    ]);
  });

  it('a lone spacing <br> between blocks does not become a paragraph', () => {
    expect(parseTopicBody('<img src="/a.jpg"><br><img src="/b.jpg">')).toEqual([
      { type: 'image', src: `${CDN}/a.jpg` },
      { type: 'image', src: `${CDN}/b.jpg` },
    ]);
  });

  it('list items carry inline content, including links', () => {
    expect(
      parseTopicBody('<ul><li>a</li><li><a href="/y/">b</a></li></ul>'),
    ).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          { children: ['a'] },
          { children: [{ type: 'link', href: `${CDN}/y/`, children: ['b'] }] },
        ],
      },
    ]);
  });

  it('caution list → list with caution variant', () => {
    expect(
      parseTopicBody('<div class="tp_caution"><ul><li>※ note</li></ul></div>'),
    ).toEqual([
      {
        type: 'list',
        ordered: false,
        variant: 'caution',
        items: [{ children: ['※ note'] }],
      },
    ]);
  });

  it('button unwraps its anchor (href absolutized)', () => {
    expect(
      parseTopicBody('<div class="btn01"><a href="/z/">Go</a></div>'),
    ).toEqual([{ type: 'button', href: `${CDN}/z/`, children: ['Go'] }]);
  });

  it('infoBox recurses its content', () => {
    expect(
      parseTopicBody('<div class="brownroundBox"><p>hi</p></div>'),
    ).toEqual([
      {
        type: 'infoBox',
        variant: 'highlight',
        children: [{ type: 'paragraph', children: ['hi'] }],
      },
    ]);
  });

  it('a box_terms of #anchor links → a toc infoBox (title + list of links)', () => {
    expect(
      parseTopicBody(
        '<div class="box_terms"><table>' +
          '<tr><td><b>目次</b></td></tr>' +
          '<tr><td><h4 class="title_icon01"><a href="#a">First</a></h4></td></tr>' +
          '<tr><td><h4 class="title_icon01"><a href="#b">Second</a></h4></td></tr>' +
          '</table></div>',
      ),
    ).toEqual([
      {
        type: 'infoBox',
        variant: 'toc',
        children: [
          {
            type: 'paragraph',
            children: [{ type: 'strong', children: ['目次'] }],
          },
          {
            type: 'list',
            ordered: false,
            items: [
              { children: [{ type: 'link', href: '#a', children: ['First'] }] },
              {
                children: [{ type: 'link', href: '#b', children: ['Second'] }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('a box_terms with no #anchor links stays a plain terms infoBox', () => {
    expect(
      parseTopicBody('<div class="box_terms"><p>対応機種 PS4</p></div>'),
    ).toEqual([
      {
        type: 'infoBox',
        variant: 'terms',
        children: [{ type: 'paragraph', children: ['対応機種 PS4'] }],
      },
    ]);
  });

  it('youtube iframe → video block', () => {
    expect(
      parseTopicBody(
        '<p><iframe src="https://www.youtube.com/embed/abc"></iframe></p>',
      ),
    ).toEqual([
      {
        type: 'video',
        provider: 'youtube',
        src: 'https://www.youtube.com/embed/abc',
      },
    ]);
  });

  it('table: th cells marked as headers, colspan captured', () => {
    expect(
      parseTopicBody(
        '<table class="contentsTable1"><tr><th>H</th></tr><tr><td colspan="2">c</td></tr></table>',
      ),
    ).toEqual([
      {
        type: 'table',
        variant: 'contents',
        rows: [
          [{ children: ['H'], header: true }],
          [{ children: ['c'], colSpan: 2 }],
        ],
      },
    ]);
  });

  it('flags a headerless single-column table as layout (the TOC pattern)', () => {
    expect(
      parseTopicBody(
        '<table><tr><td>one</td></tr><tr><td>two</td></tr></table>',
      ),
    ).toEqual([
      {
        type: 'table',
        variant: 'layout',
        rows: [[{ children: ['one'] }], [{ children: ['two'] }]],
      },
    ]);
  });

  it('does not flag multi-column, classed, or spanned tables as layout', () => {
    // two columns → a real data table
    expect(
      parseTopicBody('<table><tr><td>a</td><td>b</td></tr></table>'),
    ).toEqual([
      { type: 'table', rows: [[{ children: ['a'] }, { children: ['b'] }]] },
    ]);
    // an explicit table class keeps its own variant even when single-column
    expect(
      parseTopicBody(
        '<table class="contentsTable1"><tr><td>x</td></tr></table>',
      ),
    ).toEqual([
      { type: 'table', variant: 'contents', rows: [[{ children: ['x'] }]] },
    ]);
  });
});

describe('parseTopicBody — captioned images', () => {
  it('split: <div align=center><img> + <center>caption</center> → image.caption', () => {
    expect(
      parseTopicBody(
        '<div align="center"><img src="/dq_resource/imgs/TopicsImages/h.jpg"></div>' +
          '<center>2番地は<a href="/sc/shop/">ホテル風</a>ハウジングです！</center>',
      ),
    ).toEqual([
      {
        type: 'image',
        src: `${CDN}/dq_resource/imgs/TopicsImages/h.jpg`,
        caption: [
          '2番地は',
          { type: 'link', href: `${CDN}/sc/shop/`, children: ['ホテル風'] },
          'ハウジングです！',
        ],
      },
    ]);
  });

  it('split: tolerates a spacing <br> between the image and its caption', () => {
    expect(
      parseTopicBody(
        '<div align="center"><img src="/dq_resource/imgs/TopicsImages/h.jpg"></div>' +
          '<br /><center>キャプション</center>',
      ),
    ).toEqual([
      {
        type: 'image',
        src: `${CDN}/dq_resource/imgs/TopicsImages/h.jpg`,
        caption: ['キャプション'],
      },
    ]);
  });

  it('combined: <center><img><br>caption</center> → image.caption (edge breaks trimmed)', () => {
    expect(
      parseTopicBody(
        '<center><img src="/dq_resource/imgs/TopicsImages/s.jpg"><br>' +
          '<b>メギストリスの都F-4</b>にいます<br></center>',
      ),
    ).toEqual([
      {
        type: 'image',
        src: `${CDN}/dq_resource/imgs/TopicsImages/s.jpg`,
        caption: [
          { type: 'strong', children: ['メギストリスの都F-4'] },
          'にいます',
        ],
      },
    ]);
  });

  it('a linked banner in a centered box keeps its href and gains the caption', () => {
    expect(
      parseTopicBody(
        '<div align="center"><a href="https://x.com/"><img src="/dq_resource/imgs/TopicsImages/b.jpg"></a></div>' +
          '<center>Banner caption</center>',
      ),
    ).toEqual([
      {
        type: 'image',
        src: `${CDN}/dq_resource/imgs/TopicsImages/b.jpg`,
        href: 'https://x.com/',
        external: true,
        caption: ['Banner caption'],
      },
    ]);
  });

  it('a centered image with no following caption stays a plain block image', () => {
    expect(
      parseTopicBody(
        '<div align="center"><img src="/dq_resource/imgs/TopicsImages/x.jpg"></div>',
      ),
    ).toEqual([
      { type: 'image', src: `${CDN}/dq_resource/imgs/TopicsImages/x.jpg` },
    ]);
  });

  it('does not fold a following non-<center> block into a caption', () => {
    expect(
      parseTopicBody(
        '<div align="center"><img src="/dq_resource/imgs/TopicsImages/x.jpg"></div>' +
          '<h3 class="title02">Next section</h3>',
      ),
    ).toEqual([
      { type: 'image', src: `${CDN}/dq_resource/imgs/TopicsImages/x.jpg` },
      { type: 'heading', level: 3, children: ['Next section'] },
    ]);
  });

  it('img_newspaper box: <p class="img_newspaper"><img><br><span>…</span></p> → image.caption', () => {
    expect(
      parseTopicBody(
        '<p class="img_newspaper"><img src="/dq_resource/imgs/TopicsImages/g.jpg"><br>' +
          '<span style="color:#993300">＜ 威光の女神の背景　通常 ＞</span></p>',
      ),
    ).toEqual([
      {
        type: 'image',
        src: `${CDN}/dq_resource/imgs/TopicsImages/g.jpg`,
        variant: 'newspaper',
        caption: [
          {
            type: 'color',
            value: '#993300',
            children: ['＜ 威光の女神の背景　通常 ＞'],
          },
        ],
      },
    ]);
  });

  it('an img_newspaper box with no trailing text stays a plain block image', () => {
    expect(
      parseTopicBody(
        '<p class="img_newspaper"><img src="/dq_resource/imgs/TopicsImages/g.jpg"></p>',
      ),
    ).toEqual([
      {
        type: 'image',
        src: `${CDN}/dq_resource/imgs/TopicsImages/g.jpg`,
        variant: 'newspaper',
      },
    ]);
  });
});

describe('parseTopicBody — captioned videos', () => {
  it('centered youtube iframe + trailing span → video.caption', () => {
    expect(
      parseTopicBody(
        '<p align="center"><iframe width="480" height="270" src="https://www.youtube.com/embed/0z9muBkP5KM?rel=0" allowfullscreen></iframe><br>' +
          '<span style="color:#993300">＜ ゼネシアトランプ　（CV:川村万梨阿） ＞</span></p>',
      ),
    ).toEqual([
      {
        type: 'video',
        provider: 'youtube',
        src: 'https://www.youtube.com/embed/0z9muBkP5KM?rel=0',
        caption: [
          {
            type: 'color',
            value: '#993300',
            children: ['＜ ゼネシアトランプ　（CV:川村万梨阿） ＞'],
          },
        ],
      },
    ]);
  });

  it('split: a sibling <center> captions a centered youtube iframe', () => {
    expect(
      parseTopicBody(
        '<div align="center"><iframe src="https://www.youtube.com/embed/abc"></iframe></div>' +
          '<center>プロモーション映像</center>',
      ),
    ).toEqual([
      {
        type: 'video',
        provider: 'youtube',
        src: 'https://www.youtube.com/embed/abc',
        caption: ['プロモーション映像'],
      },
    ]);
  });

  it('a centered youtube iframe with no caption stays a plain video block', () => {
    expect(
      parseTopicBody(
        '<p align="center"><iframe src="https://www.youtube.com/embed/abc"></iframe></p>',
      ),
    ).toEqual([
      {
        type: 'video',
        provider: 'youtube',
        src: 'https://www.youtube.com/embed/abc',
      },
    ]);
  });

  it('an image and an iframe in one box is layout, not a captioned figure', () => {
    expect(
      parseTopicBody(
        '<div align="center"><img src="/dq_resource/imgs/TopicsImages/x.jpg">' +
          '<iframe src="https://www.youtube.com/embed/abc"></iframe>テキスト</div>',
      ),
    ).toEqual([
      { type: 'image', src: `${CDN}/dq_resource/imgs/TopicsImages/x.jpg` },
      {
        type: 'video',
        provider: 'youtube',
        src: 'https://www.youtube.com/embed/abc',
      },
      { type: 'paragraph', children: ['テキスト'] },
    ]);
  });
});

describe('parseTopicBody — section anchors', () => {
  it('lifts a bare <a id> jump target onto the following heading (no stray paragraph)', () => {
    expect(
      parseTopicBody(
        '<br><br><a id="dra"></a><h2 class="title02">章タイトル</h2>',
      ),
    ).toEqual([
      { type: 'heading', level: 2, children: ['章タイトル'], anchor: 'dra' },
    ]);
  });

  it('accepts the old <a name> form and skips <br> between the anchor and heading', () => {
    expect(parseTopicBody('<a name="sec"></a><br><h3>Section</h3>')).toEqual([
      { type: 'heading', level: 3, children: ['Section'], anchor: 'sec' },
    ]);
  });

  it('drops a bare <a id> not followed by a heading (no empty-link paragraph)', () => {
    expect(parseTopicBody('<a id="x"></a><p>Body text.</p>')).toEqual([
      { type: 'paragraph', children: ['Body text.'] },
    ]);
  });

  it('leaves a normal in-text link alone (it has text, so it is not a bare anchor)', () => {
    expect(parseTopicBody('<p>go <a id="k" href="/x/">here</a></p>')).toEqual([
      {
        type: 'paragraph',
        children: [
          'go ',
          { type: 'link', href: `${CDN}/x/`, children: ['here'] },
        ],
      },
    ]);
  });

  it('captures an id placed directly on the heading element (e.g. <h2 id="Puu">)', () => {
    expect(
      parseTopicBody('<h2 class="title01" id="Puu">タイトル</h2>'),
    ).toEqual([
      { type: 'heading', level: 1, children: ['タイトル'], anchor: 'Puu' },
    ]);
  });

  it("a heading's own id wins over a preceding bare anchor", () => {
    expect(parseTopicBody('<a id="dra"></a><h3 id="own">T</h3>')).toEqual([
      { type: 'heading', level: 3, children: ['T'], anchor: 'own' },
    ]);
  });
});
