import { describe, expect, it } from 'vitest';

import { parsePlayguidePage } from './playguide-body-scraper';
import { parsePlayguideLinks } from './playguide-crawl-scraper';

/** A stripped-down playguide page: a hub with links + a content page. */
const HUB_HTML = `
<div id="contentArea"><div class="cttBox">
  <h1 id="cttTitle">プレイガイド</h1>
  <h2 class="tit_icon">プレイガイドインデックス</h2>
  <ul>
    <li><a href="/sc/public/playguide/guide_1_1_win">Windows版</a></li>
    <li><a href="https://hiroba.dqx.jp/sc/public/playguide/guide_4_2/">アストルティアを冒険しよう</a></li>
    <li><a href="/sc/public/playguide/guide_1_1_win">dup ignored</a></li>
    <li><a href="/sc/public/playguide/BANNER"><img src="/x.png"></a></li>
    <li><a href="/sc/news/detail/abc/">not a playguide</a></li>
  </ul>
</div></div>`;

const CONTENT_HTML = `
<div id="contentArea"><div class="cttBox">
  <h1 id="cttTitle">プレイガイド</h1>
  <h2 class="tit_icon">アストルティアを冒険しよう</h2>
  <h2 class="iconTitle">エリアの地図</h2>
  <p>本文テキスト。</p>
</div></div>`;

describe('parsePlayguideLinks', () => {
  it('extracts deduped playguide slugs with anchor text, ignoring other links', () => {
    const links = parsePlayguideLinks(HUB_HTML);
    expect(links).toEqual([
      { slug: 'guide_1_1_win', title: 'Windows版' },
      { slug: 'guide_4_2', title: 'アストルティアを冒険しよう' },
      { slug: 'banner', title: '' }, // slug lower-cased; image link → empty title
    ]);
  });
});

describe('parsePlayguidePage', () => {
  it('prefers the specific iconTitle heading and parses the body', () => {
    const { titleJa, specificTitle, blocks } = parsePlayguidePage(
      CONTENT_HTML,
      'guide_4_2',
    );
    expect(specificTitle).toBe('エリアの地図');
    expect(titleJa).toBe('エリアの地図');
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('leaves specificTitle null when the page has only a section heading', () => {
    const { titleJa, specificTitle } = parsePlayguidePage(HUB_HTML, 'guide01');
    // No iconTitle → not authoritative over a crawl label…
    expect(specificTitle).toBeNull();
    // …but the self-contained fallback still beats the generic #cttTitle.
    expect(titleJa).toBe('プレイガイドインデックス');
  });
});
