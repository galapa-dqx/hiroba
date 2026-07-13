import * as cheerio from 'cheerio';
import fetchMock from 'fetch-mock';
import { Temporal } from 'temporal-polyfill';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CATEGORY_TO_ID,
  extractTotalPages,
  getAllCategories,
  listPageUrl,
  parseListPage,
  scrapeCategory,
  scrapeNewsList,
  type ListItem,
} from './list-scraper';

describe('list-scraper', () => {
  describe('CATEGORY_TO_ID', () => {
    it('maps categories to numeric IDs', () => {
      expect(CATEGORY_TO_ID.news).toBe(0);
      expect(CATEGORY_TO_ID.event).toBe(1);
      expect(CATEGORY_TO_ID.update).toBe(2);
      expect(CATEGORY_TO_ID.maintenance).toBe(3);
    });
  });

  describe('getAllCategories', () => {
    it('returns all category values', () => {
      const categories = getAllCategories();
      expect(categories).toContain('news');
      expect(categories).toContain('event');
      expect(categories).toContain('update');
      expect(categories).toContain('maintenance');
    });
  });

  describe('parseListPage', () => {
    it('extracts news items from list HTML', () => {
      const html = `
        <table>
          <tr>
            <td class="news"><a href="/sc/news/detail/12345/">Test News Title</a></td>
            <td class="date"><div>2024/01/15 10:00</div></td>
          </tr>
        </table>
      `;

      const items = parseListPage(html, 'news');

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('12345');
      expect(items[0].titleJa).toBe('Test News Title');
      expect(items[0].category).toBe('news');
      expect(items[0].publishedAt).toBeInstanceOf(Temporal.Instant);
    });

    it('extracts multiple items', () => {
      const html = `
        <table>
          <tr>
            <td class="news"><a href="/sc/news/detail/111/">First News</a></td>
            <td class="date"><div>2024/01/15</div></td>
          </tr>
          <tr>
            <td class="news"><a href="/sc/news/detail/222/">Second News</a></td>
            <td class="date"><div>2024/01/14</div></td>
          </tr>
        </table>
      `;

      const items = parseListPage(html, 'event');

      expect(items).toHaveLength(2);
      expect(items[0].id).toBe('111');
      expect(items[1].id).toBe('222');
      expect(items[0].category).toBe('event');
      expect(items[1].category).toBe('event');
    });

    it('skips duplicate IDs', () => {
      const html = `
        <a href="/sc/news/detail/123/">First occurrence</a>
        <a href="/sc/news/detail/123/">Duplicate</a>
      `;

      const items = parseListPage(html, 'news');

      expect(items).toHaveLength(1);
      expect(items[0].titleJa).toBe('First occurrence');
    });

    it('skips navigation links with empty or generic titles', () => {
      const html = `
        <a href="/sc/news/detail/100/">Real Title</a>
        <a href="/sc/news/detail/101/">詳細</a>
        <a href="/sc/news/detail/102/">もっと見る</a>
        <a href="/sc/news/detail/103/"></a>
      `;

      const items = parseListPage(html, 'news');

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('100');
    });

    it('extracts date from sibling td.date element', () => {
      const html = `
        <table>
          <tr>
            <td class="news"><a href="/sc/news/detail/123/">Title</a></td>
            <td class="date"><div>2024/06/20 14:30</div></td>
          </tr>
        </table>
      `;

      const items = parseListPage(html, 'news');

      expect(items).toHaveLength(1);
      // 2024/06/20 14:30 JST == 2024-06-20T05:30:00Z
      expect(items[0].publishedAt.toString()).toBe('2024-06-20T05:30:00Z');
    });

    it('falls back to row text for date extraction', () => {
      const html = `
        <table>
          <tr>
            <td><a href="/sc/news/detail/123/">Title</a></td>
            <td>2024/03/10</td>
          </tr>
        </table>
      `;

      const items = parseListPage(html, 'news');

      expect(items).toHaveLength(1);
      // 2024/03/10 (date-only) anchored to midnight JST == 2024-03-09T15:00:00Z
      expect(items[0].publishedAt.toString()).toBe('2024-03-09T15:00:00Z');
    });

    it('handles links with trailing slash variations', () => {
      const html = `
        <a href="/sc/news/detail/111">No trailing slash</a>
        <a href="/sc/news/detail/222/">With trailing slash</a>
      `;

      const items = parseListPage(html, 'news');

      expect(items).toHaveLength(2);
      expect(items.map((i) => i.id).sort()).toEqual(['111', '222']);
    });

    it('returns empty array for HTML with no news links', () => {
      const html = `<html><body><p>No news here</p></body></html>`;

      const items = parseListPage(html, 'news');

      expect(items).toEqual([]);
    });
  });

  describe('scrapeNewsList', () => {
    beforeEach(() => {
      fetchMock.mockGlobal();
    });

    afterEach(() => {
      fetchMock.unmockGlobal();
      fetchMock.removeRoutes();
      fetchMock.clearHistory();
    });

    it('constructs correct URL for first page', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0', {
        body: '<html></html>',
      });

      const generator = scrapeNewsList('news');
      await generator.next();

      const calls = fetchMock.callHistory.calls();
      expect(calls[0].url).toBe('https://hiroba.dqx.jp/sc/news/category/0');
    });

    it('uses category ID in URL', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/2', {
        body: '<html></html>',
      });

      const generator = scrapeNewsList('update');
      await generator.next();

      const calls = fetchMock.callHistory.calls();
      expect(calls[0].url).toBe('https://hiroba.dqx.jp/sc/news/category/2');
    });

    it('yields items from a single page', async () => {
      const html = `
        <a href="/sc/news/detail/123/">Test Item</a>
      `;
      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0', { body: html });

      const generator = scrapeNewsList('news');
      const result = await generator.next();

      expect(result.done).toBe(false);
      const items = result.value as ListItem[];
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('123');
    });

    it('fetches multiple pages when pagination exists', async () => {
      // Display page 2 lives at URL suffix 1 — the path segment is 0-based.
      const page1Html = `
        <a href="/sc/news/detail/111/">Page 1 Item</a>
        <a href="/sc/news/category/0/1" data-pageno="1">2</a>
      `;
      const page2Html = `
        <a href="/sc/news/detail/222/">Page 2 Item</a>
      `;

      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0', {
        body: page1Html,
      });
      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0/1', {
        body: page2Html,
      });

      const generator = scrapeNewsList('news');
      const page1 = await generator.next();
      const page2 = await generator.next();

      const items1 = page1.value as ListItem[];
      const items2 = page2.value as ListItem[];
      expect(items1).toHaveLength(1);
      expect(items1[0].id).toBe('111');
      expect(items2).toHaveLength(1);
      expect(items2[0].id).toBe('222');
    });

    it('stops when page returns no items', async () => {
      const page1Html = `<a href="/sc/news/detail/111/">Item</a>`;
      const page2Html = `<html><body>Empty page</body></html>`;

      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0', {
        body: page1Html,
      });
      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0/1', {
        body: page2Html,
      });

      const allItems: unknown[] = [];
      for await (const items of scrapeNewsList('news')) {
        allItems.push(...items);
      }

      expect(allItems).toHaveLength(1);
    });

    it('throws error on failed fetch', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0', {
        status: 500,
      });

      const generator = scrapeNewsList('news');

      await expect(generator.next()).rejects.toThrow(
        'Failed to fetch list page: 500',
      );
    });
  });

  describe('scrapeCategory', () => {
    beforeEach(() => {
      fetchMock.mockGlobal();
    });

    afterEach(() => {
      fetchMock.unmockGlobal();
      fetchMock.removeRoutes();
      fetchMock.clearHistory();
    });

    it('returns all items from all pages', async () => {
      const page1Html = `
        <a href="/sc/news/detail/111/">Item 1</a>
        <a href="/sc/news/category/1/1" data-pageno="1">2</a>
      `;
      const page2Html = `
        <a href="/sc/news/detail/222/">Item 2</a>
      `;

      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/1', {
        body: page1Html,
      });
      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/1/1', {
        body: page2Html,
      });

      const items = await scrapeCategory('event');

      expect(items).toHaveLength(2);
      expect(items.map((i) => i.id).sort()).toEqual(['111', '222']);
    });
  });

  describe('listPageUrl', () => {
    it('maps 1-based display pages onto the 0-based URL path segment', () => {
      expect(listPageUrl('maintenance', 1)).toBe(
        'https://hiroba.dqx.jp/sc/news/category/3',
      );
      expect(listPageUrl('maintenance', 2)).toBe(
        'https://hiroba.dqx.jp/sc/news/category/3/1',
      );
      expect(listPageUrl('maintenance', 56)).toBe(
        'https://hiroba.dqx.jp/sc/news/category/3/55',
      );
    });
  });

  // Fixtures mirror hiroba's real pagination (captured live from
  // /sc/news/category/3, a 56-display-page archive): the current page is an
  // unlinked <li class="location">, link hrefs carry displayPage - 1, and an
  // out-of-range request is clamped to the last page rendered WITHOUT a
  // location marker.
  describe('extractTotalPages', () => {
    const load = (html: string) => cheerio.load(html);

    it('counts the last link on a first page (suffix + 1)', () => {
      const $ = load(`
        <div class="pageNavi"><ul>
          <li class="location">1</li>
          <li><a href="/sc/news/category/3/1" data-pageno="1">2</a></li>
          <li><a href="/sc/news/category/3/8" data-pageno="8">9</a></li>
          <li class="next"><a href="/sc/news/category/3/1" class="pagerNext">next</a></li>
          <li class="last"><a href="/sc/news/category/3/55" class="pagerBottom">last</a></li>
        </ul></div>
      `);
      expect(extractTotalPages($)).toBe(56);
    });

    it('takes the genuine last page total from its own location marker', () => {
      // The last page never links to itself — links stop one short, and only
      // the unlinked location marker carries the true display total.
      const $ = load(`
        <div class="pageNavi"><ul>
          <li class="first"><a href="/sc/news/category/3/0" class="pagerTop">first</a></li>
          <li class="prev"><a href="/sc/news/category/3/54" class="pagerPrev">prev</a></li>
          <li><a href="/sc/news/category/3/47" data-pageno="47">48</a></li>
          <li><a href="/sc/news/category/3/54" data-pageno="54">55</a></li>
          <li class="location">56</li>
        </ul></div>
      `);
      expect(extractTotalPages($)).toBe(56);
    });

    it('reports the true total on a clamped out-of-range page', () => {
      // No location marker at all; the link window includes the real last
      // page — so a caller that requested page 57 sees 57 > 56 and stops.
      const $ = load(`
        <div class="pageNavi"><ul>
          <li class="first"><a href="/sc/news/category/3/0" class="pagerTop">first</a></li>
          <li><a href="/sc/news/category/3/54" data-pageno="54">55</a></li>
          <li><a href="/sc/news/category/3/55" data-pageno="55">56</a></li>
        </ul></div>
      `);
      expect(extractTotalPages($)).toBe(56);
    });

    it('returns 1 when there is no pagination', () => {
      expect(extractTotalPages(load('<p>single page</p>'))).toBe(1);
    });
  });
});
