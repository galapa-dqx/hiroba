import fetchMock from 'fetch-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchNewsBody } from './body-scraper';

describe('body-scraper', () => {
  beforeEach(() => {
    fetchMock.mockGlobal();
  });

  afterEach(() => {
    fetchMock.unmockGlobal();
    fetchMock.removeRoutes();
    fetchMock.clearHistory();
  });

  describe('fetchNewsBody', () => {
    it('constructs the correct URL for the given ID', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/12345/', {
        body: "<div class='newsContent'>Test</div>",
      });

      await fetchNewsBody('12345');

      const calls = fetchMock.callHistory.calls();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://hiroba.dqx.jp/sc/news/detail/12345/');
      expect(calls[0].options?.headers).toHaveProperty('user-agent');
    });

    it('throws an error when response is not ok', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/99999/', {
        status: 404,
      });

      await expect(fetchNewsBody('99999')).rejects.toThrow(
        'Failed to fetch detail page: 404',
      );
    });

    it('extracts content from div.newsContent', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/123/', {
        body: "<html><body><div class='newsContent'>Hello World</div></body></html>",
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Hello World');
    });

    it('converts br tags to newlines', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/123/', {
        body: "<div class='newsContent'>Line 1<br>Line 2<br/>Line 3<br />Line 4</div>",
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Line 1\nLine 2\nLine 3\nLine 4');
    });

    it('converts closing p tags to double newlines', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/123/', {
        body: "<div class='newsContent'><p>Paragraph 1</p><p>Paragraph 2</p></div>",
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Paragraph 1\n\nParagraph 2');
    });

    it('strips all other HTML tags', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/123/', {
        body: "<div class='newsContent'><strong>Bold</strong> and <em>italic</em> text</div>",
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Bold and italic text');
    });

    it('replaces &nbsp; with regular spaces', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/123/', {
        body: "<div class='newsContent'>Word&nbsp;with&nbsp;spaces</div>",
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Word with spaces');
    });

    it('collapses multiple newlines to double newlines', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/123/', {
        body: "<div class='newsContent'>Line 1<br><br><br><br>Line 2</div>",
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Line 1\n\nLine 2');
    });

    it('trims whitespace from result', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/123/', {
        body: "<div class='newsContent'>   Trimmed content   </div>",
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Trimmed content');
    });

    it('returns empty string when newsContent element is missing', async () => {
      fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/123/', {
        body: '<html><body><div>No news content here</div></body></html>',
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('');
    });

    it('handles complex HTML with nested elements', async () => {
      const complexHtml = `
        <div class='newsContent'>
          <h2>Title</h2>
          <p>First paragraph with <a href="#">link</a>.</p>
          <ul>
            <li>Item 1</li>
            <li>Item 2</li>
          </ul>
          <p>Final paragraph.</p>
        </div>
      `;

      fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/123/', {
        body: complexHtml,
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toContain('Title');
      expect(result.contentJa).toContain('First paragraph with link.');
      expect(result.contentJa).toContain('Item 1');
      expect(result.contentJa).toContain('Item 2');
      expect(result.contentJa).toContain('Final paragraph.');
    });
  });
});
