import { describe, expect, it } from 'vitest';

import { rewriteImageSrc } from './image-url';

describe('rewriteImageSrc', () => {
  it('proxies the CDN host, preserving the host in the path', () => {
    expect(rewriteImageSrc('https://cache.hiroba.dqx.jp/dq_resource/imgs/a.jpg')).toBe(
      '/img/cache.hiroba.dqx.jp/dq_resource/imgs/a.jpg',
    );
    expect(rewriteImageSrc('http://cache.hiroba.dqx.jp/x/y.png')).toBe('/img/cache.hiroba.dqx.jp/x/y.png');
  });

  it('canonicalizes CDN aliases to the primary host (dedup)', () => {
    // hiroba.dqx.jp and close.cache.hiroba.dqx.jp mirror the same /dq_resource assets.
    expect(rewriteImageSrc('https://hiroba.dqx.jp/dq_resource/z.gif')).toBe(
      '/img/cache.hiroba.dqx.jp/dq_resource/z.gif',
    );
    expect(rewriteImageSrc('https://close.cache.hiroba.dqx.jp/dq_resource/a.jpg')).toBe(
      '/img/cache.hiroba.dqx.jp/dq_resource/a.jpg',
    );
  });

  it('keeps distinct DQX hosts distinct (no collision)', () => {
    // faceicon is a different host with its own namespace — must not collapse into the CDN host.
    expect(rewriteImageSrc('https://faceicon.dqx.jp/icon1/846/8460/x.jpg')).toBe(
      '/img/faceicon.dqx.jp/icon1/846/8460/x.jpg',
    );
    // Same trailing path on two different hosts → two different proxy keys.
    expect(rewriteImageSrc('https://faceicon.dqx.jp/a.jpg')).not.toBe(
      rewriteImageSrc('https://cache.hiroba.dqx.jp/a.jpg'),
    );
  });

  it('preserves query strings', () => {
    expect(rewriteImageSrc('https://cache.hiroba.dqx.jp/a.jpg?v=2')).toBe('/img/cache.hiroba.dqx.jp/a.jpg?v=2');
  });

  it('proxies protocol-relative CDN URLs', () => {
    expect(rewriteImageSrc('//cache.hiroba.dqx.jp/a.jpg')).toBe('/img/cache.hiroba.dqx.jp/a.jpg');
  });

  it('proxies root-relative dq_resource paths to the canonical host', () => {
    expect(rewriteImageSrc('/dq_resource/imgs/a.jpg')).toBe('/img/cache.hiroba.dqx.jp/dq_resource/imgs/a.jpg');
  });

  it('leaves already-proxied paths untouched', () => {
    expect(rewriteImageSrc('/img/cache.hiroba.dqx.jp/dq_resource/a.jpg')).toBe(
      '/img/cache.hiroba.dqx.jp/dq_resource/a.jpg',
    );
  });

  it('leaves off-site (non-dqx.jp) URLs untouched', () => {
    expect(rewriteImageSrc('http://www.ganganonline.com/comic/dqx/img/comic_main.jpg')).toBe(
      'http://www.ganganonline.com/comic/dqx/img/comic_main.jpg',
    );
    expect(rewriteImageSrc('https://i.ytimg.com/vi/x/hqdefault.jpg')).toBe('https://i.ytimg.com/vi/x/hqdefault.jpg');
  });

  it('leaves other relative paths and data URIs untouched', () => {
    expect(rewriteImageSrc('/assets/local.png')).toBe('/assets/local.png');
    expect(rewriteImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('handles empty input', () => {
    expect(rewriteImageSrc('')).toBe('');
  });
});
