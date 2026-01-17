import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchNewsBody } from './body-scraper';

describe('body-scraper', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  describe('fetchNewsBody', () => {
    it('constructs the correct URL for the given ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("<div class='newsContent'>Test</div>"),
      });

      await fetchNewsBody('12345');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://hiroba.dqx.jp/sc/news/detail/12345/',
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.any(String),
          }),
        }),
      );
    });

    it('throws an error when response is not ok', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(fetchNewsBody('99999')).rejects.toThrow(
        'Failed to fetch detail page: 404',
      );
    });

    it('extracts content from div.newsContent', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            "<html><body><div class='newsContent'>Hello World</div></body></html>",
          ),
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Hello World');
    });

    it('converts br tags to newlines', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            "<div class='newsContent'>Line 1<br>Line 2<br/>Line 3<br />Line 4</div>",
          ),
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Line 1\nLine 2\nLine 3\nLine 4');
    });

    it('converts closing p tags to double newlines', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            "<div class='newsContent'><p>Paragraph 1</p><p>Paragraph 2</p></div>",
          ),
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Paragraph 1\n\nParagraph 2');
    });

    it('strips all other HTML tags', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            "<div class='newsContent'><strong>Bold</strong> and <em>italic</em> text</div>",
          ),
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Bold and italic text');
    });

    it('replaces &nbsp; with regular spaces', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            "<div class='newsContent'>Word&nbsp;with&nbsp;spaces</div>",
          ),
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Word with spaces');
    });

    it('collapses multiple newlines to double newlines', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            "<div class='newsContent'>Line 1<br><br><br><br>Line 2</div>",
          ),
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Line 1\n\nLine 2');
    });

    it('trims whitespace from result', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            "<div class='newsContent'>   Trimmed content   </div>",
          ),
      });

      const result = await fetchNewsBody('123');

      expect(result.contentJa).toBe('Trimmed content');
    });

    it('returns empty string when newsContent element is missing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            '<html><body><div>No news content here</div></body></html>',
          ),
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

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(complexHtml),
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
