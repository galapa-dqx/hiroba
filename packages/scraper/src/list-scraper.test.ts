import fetchMock from 'fetch-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CATEGORY_TO_ID,
  getAllCategories,
  parseListPage,
  scrapeCategory,
  scrapeNewsList,
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
      expect(items[0].publishedAt).toBeTypeOf('number');
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
        <tr>
          <td class="news"><a href="/sc/news/detail/123/">Title</a></td>
          <td class="date"><div>2024/06/20 14:30</div></td>
        </tr>
      `;

      const items = parseListPage(html, 'news');

      expect(items).toHaveLength(1);
      // The exact timestamp depends on parseJstDateToUnix, just verify it's set
      expect(items[0].publishedAt).toBeGreaterThan(0);
    });

    it('falls back to row text for date extraction', () => {
      const html = `
        <tr>
          <td><a href="/sc/news/detail/123/">Title</a></td>
          <td>2024/03/10</td>
        </tr>
      `;

      const items = parseListPage(html, 'news');

      expect(items).toHaveLength(1);
      expect(items[0].publishedAt).toBeGreaterThan(0);
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

      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe('123');
    });

    it('fetches multiple pages when pagination exists', async () => {
      const page1Html = `
        <a href="/sc/news/detail/111/">Page 1 Item</a>
        <a href="/sc/news/category/0/2">Page 2</a>
      `;
      const page2Html = `
        <a href="/sc/news/detail/222/">Page 2 Item</a>
      `;

      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0', {
        body: page1Html,
      });
      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0/2', {
        body: page2Html,
      });

      const generator = scrapeNewsList('news');
      const page1 = await generator.next();
      const page2 = await generator.next();

      expect(page1.value).toHaveLength(1);
      expect(page1.value[0].id).toBe('111');
      expect(page2.value).toHaveLength(1);
      expect(page2.value[0].id).toBe('222');
    });

    it('stops when page returns no items', async () => {
      const page1Html = `<a href="/sc/news/detail/111/">Item</a>`;
      const page2Html = `<html><body>Empty page</body></html>`;

      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0', {
        body: page1Html,
      });
      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0/2', {
        body: page2Html,
      });

      const allItems: unknown[] = [];
      for await (const items of scrapeNewsList('news')) {
        allItems.push(...items);
      }

      expect(allItems).toHaveLength(1);
    });

    it('throws error on failed fetch', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/0', { status: 500 });

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
        <a href="/sc/news/category/1/2">Page 2</a>
      `;
      const page2Html = `
        <a href="/sc/news/detail/222/">Item 2</a>
      `;

      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/1', {
        body: page1Html,
      });
      fetchMock.get('https://hiroba.dqx.jp/sc/news/category/1/2', {
        body: page2Html,
      });

      const items = await scrapeCategory('event');

      expect(items).toHaveLength(2);
      expect(items.map((i) => i.id).sort()).toEqual(['111', '222']);
    });
  });
});
