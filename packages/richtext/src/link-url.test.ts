import { describe, expect, it } from 'vitest';

import { rewriteArticleHref } from './link-url';

const ID = '63cb524a9f51b7858733e1108bf556fa';

describe('rewriteArticleHref', () => {
  it('rewrites topic detail links to our /topics route', () => {
    expect(
      rewriteArticleHref(`https://hiroba.dqx.jp/sc/topics/detail/${ID}/`),
    ).toBe(`/topics/${ID}`);
  });

  it('rewrites news detail links to our /news route', () => {
    expect(
      rewriteArticleHref(`https://hiroba.dqx.jp/sc/news/detail/${ID}/`),
    ).toBe(`/news/${ID}`);
  });

  it('tolerates http, a missing trailing slash, and mixed case', () => {
    expect(
      rewriteArticleHref(`http://hiroba.dqx.jp/sc/topics/detail/${ID}`),
    ).toBe(`/topics/${ID}`);
    expect(
      rewriteArticleHref(
        `https://hiroba.dqx.jp/SC/Topics/Detail/${ID.toUpperCase()}/`,
      ),
    ).toBe(`/topics/${ID}`);
  });

  it('rewrites playguide links to our /playguide route', () => {
    expect(
      rewriteArticleHref('https://hiroba.dqx.jp/sc/public/playguide/guide01'),
    ).toBe('/playguide/guide01');
    expect(
      rewriteArticleHref(
        'https://hiroba.dqx.jp/sc/public/playguide/guide_4_2/',
      ),
    ).toBe('/playguide/guide_4_2');
    expect(
      rewriteArticleHref(
        'https://hiroba.dqx.jp/sc/public/playguide/wintrial_1_kantan',
      ),
    ).toBe('/playguide/wintrial_1_kantan');
    // mixed case host/path is normalized; a #fragment survives, a query drops.
    expect(
      rewriteArticleHref(
        'http://hiroba.dqx.jp/sc/public/playguide/Accessinfo/?ref=top#map',
      ),
    ).toBe('/playguide/accessinfo#map');
  });

  it('keeps a #fragment and drops a query string', () => {
    expect(
      rewriteArticleHref(`https://hiroba.dqx.jp/sc/topics/detail/${ID}/#dra`),
    ).toBe(`/topics/${ID}#dra`);
    expect(
      rewriteArticleHref(
        `https://hiroba.dqx.jp/sc/topics/detail/${ID}/?ref=top#dra`,
      ),
    ).toBe(`/topics/${ID}#dra`);
  });

  it('leaves non-article hrefs unchanged', () => {
    for (const href of [
      'https://hiroba.dqx.jp/sc/shop/', // other hiroba page
      'https://hiroba.dqx.jp/sc/topics/', // the topics list, not a detail page
      `https://hiroba.dqx.jp/sc/topics/detail/notahexid/`, // malformed id
      `https://www.dqx.jp/sc/topics/detail/${ID}/`, // different host
      'https://example.com/', // off-site
      '#dra', // in-page anchor
      '', // empty
    ])
      expect(rewriteArticleHref(href)).toBe(href);
  });
});
