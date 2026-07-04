import fetchMock from 'fetch-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchNewsBody, parseNewsBody } from './body-scraper';

describe('parseNewsBody', () => {
  it('parses newsContent text into a paragraph block', () => {
    const blocks = parseNewsBody(
      "<html><body><div class='newsContent'>Hello World</div></body></html>",
    );

    expect(blocks).toEqual([{ type: 'paragraph', children: ['Hello World'] }]);
  });

  it('preserves links (the sqex.to shortlinks the old plaintext path destroyed)', () => {
    const blocks = parseNewsBody(
      `<div class='newsContent'><p>See <a href="https://sqex.to/abc" target="_blank">here</a> for details.</p></div>`,
    );

    expect(blocks).toEqual([
      {
        type: 'paragraph',
        children: [
          'See ',
          {
            type: 'link',
            href: 'https://sqex.to/abc',
            external: true,
            children: ['here'],
          },
          ' for details.',
        ],
      },
    ]);
  });

  it('keeps <br> line breaks as break nodes', () => {
    const blocks = parseNewsBody(
      "<div class='newsContent'><p>Line 1<br>Line 2</p></div>",
    );

    expect(blocks).toEqual([
      {
        type: 'paragraph',
        children: ['Line 1', { type: 'break' }, 'Line 2'],
      },
    ]);
  });

  it('returns an empty tree when the newsContent element is missing', () => {
    const blocks = parseNewsBody(
      '<html><body><div>No news content here</div></body></html>',
    );

    expect(blocks).toEqual([]);
  });
});

describe('fetchNewsBody', () => {
  beforeEach(() => {
    fetchMock.mockGlobal();
  });

  afterEach(() => {
    fetchMock.unmockGlobal();
    fetchMock.removeRoutes();
    fetchMock.clearHistory();
  });

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

  it('parses the fetched detail page into blocks', async () => {
    fetchMock.get('https://hiroba.dqx.jp/sc/news/detail/123/', {
      body: "<html><body><div class='newsContent'>Hello World</div></body></html>",
    });

    const blocks = await fetchNewsBody('123');

    expect(blocks).toEqual([{ type: 'paragraph', children: ['Hello World'] }]);
  });
});
