import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import {
  parseTopicsListPage,
  stripTitleDateSuffix,
} from './topics-list-scraper';

// DQX titles separate the title from its date with a full-width space (U+3000).
// Use the escape (not a literal) so lint's no-irregular-whitespace stays happy
// while the resulting strings match the real page bytes exactly.
const SP = '\u3000';

/** JST midnight instant for the given Y/M/D, as an ISO string for comparison. */
function jstMidnight(y: number, m: number, d: number): string {
  return Temporal.PlainDate.from({ year: y, month: m, day: d })
    .toZonedDateTime('Asia/Tokyo')
    .toInstant()
    .toString();
}

describe('parseTopicsListPage', () => {
  it('extracts id, date-stripped title, and date from h2.iconTitle entries', () => {
    // Mirrors a real backnumber month page: header + a body preview that
    // cross-links to a *different* topic (which must NOT be picked up).
    const html = `
      <div class="cttBox">
        <h2 class="iconTitle"><a href="/sc/topics/detail/4baf54f36935058bcc696fcef3f4689b/">超ドラゴンクエストXTV #41${SP}(2024/1/26)</a></h2>
        <div class="newsContent">
          <a href="/sc/topics/detail/ffffffffffffffffffffffffffffffff/">関連リンク</a>
        </div>
        <h2 class="iconTitle"><a href="/sc/topics/detail/60a0575e00000000000000000000dead/">2024年 新年のごあいさつ${SP}（2024/1/1）</a></h2>
        <div class="newsContent"></div>
      </div>`;

    const items = parseTopicsListPage(html, { year: 2024, month: 1 });

    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('4baf54f36935058bcc696fcef3f4689b');
    // The date suffix (and its U+3000 separator) is stripped from the stored
    // title — publishedAt already carries the date.
    expect(items[0].titleJa).toBe('超ドラゴンクエストXTV #41');
    expect(items[0].publishedAt.toString()).toBe(jstMidnight(2024, 1, 26));
    expect(items[1].id).toBe('60a0575e00000000000000000000dead');
    // The leading "2024年" must not be mistaken for the date — (2024/1/1) wins.
    expect(items[1].titleJa).toBe('2024年 新年のごあいさつ');
    expect(items[1].publishedAt.toString()).toBe(jstMidnight(2024, 1, 1));
  });

  it('handles the newsListLnk class (current page) and 更新 date suffix', () => {
    const html = `
      <h2 class="iconTitle"><a class="newsListLnk" href="/sc/topics/detail/68897f19b106926ed889fe3f7e3d01c9/">毎月10日はDQXで遊ぼう！${SP}（2026/7/3）</a></h2>
      <h2 class="iconTitle"><a href="/sc/topics/detail/77c493ec00000000000000000000beef/">アスコレ開催！${SP}（2024/1/16更新）</a></h2>`;

    const items = parseTopicsListPage(html);

    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('68897f19b106926ed889fe3f7e3d01c9');
    expect(items[0].titleJa).toBe('毎月10日はDQXで遊ぼう！');
    expect(items[0].publishedAt.toString()).toBe(jstMidnight(2026, 7, 3));
    // Date parsed (and stripped) despite the trailing 更新 before the paren.
    expect(items[1].titleJa).toBe('アスコレ開催！');
    expect(items[1].publishedAt.toString()).toBe(jstMidnight(2024, 1, 16));
  });

  it('falls back to the month page when a title has no date', () => {
    const html = `
      <h2 class="iconTitle"><a href="/sc/topics/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/">日付なしのお知らせ</a></h2>`;

    const items = parseTopicsListPage(html, { year: 2013, month: 5 });

    expect(items).toHaveLength(1);
    expect(items[0].titleJa).toBe('日付なしのお知らせ');
    expect(items[0].publishedAt.toString()).toBe(jstMidnight(2013, 5, 1));
  });

  it('deduplicates repeated ids', () => {
    const html = `
      <h2 class="iconTitle"><a href="/sc/topics/detail/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/">タイトル${SP}（2020/2/2）</a></h2>
      <h2 class="iconTitle"><a href="/sc/topics/detail/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/">タイトル${SP}（2020/2/2）</a></h2>`;

    expect(parseTopicsListPage(html)).toHaveLength(1);
  });
});

describe('stripTitleDateSuffix', () => {
  it('strips full-width parens, half-width parens, and 更新 variants', () => {
    expect(stripTitleDateSuffix(`タイトル${SP}（2026/7/3）`)).toBe('タイトル');
    expect(stripTitleDateSuffix(`タイトル${SP}(2024/1/26)`)).toBe('タイトル');
    expect(stripTitleDateSuffix(`タイトル${SP}（2024/1/16更新）`)).toBe(
      'タイトル',
    );
    expect(stripTitleDateSuffix('タイトル（2024年1月16日）')).toBe('タイトル');
  });

  it('leaves titles without a trailing date annotation alone', () => {
    expect(stripTitleDateSuffix('日付なしのお知らせ')).toBe(
      '日付なしのお知らせ',
    );
    // A leading/mid-title year is not a posting-date suffix.
    expect(stripTitleDateSuffix('2024年 新年のごあいさつ')).toBe(
      '2024年 新年のごあいさつ',
    );
    // Parenthesized non-date content stays.
    expect(stripTitleDateSuffix('アップデート情報（バージョン7.2）')).toBe(
      'アップデート情報（バージョン7.2）',
    );
  });

  it('keeps the original when stripping would empty the title', () => {
    expect(stripTitleDateSuffix('（2024/1/1）')).toBe('（2024/1/1）');
  });
});
