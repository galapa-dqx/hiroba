import { describe, expect, it } from 'vitest';

import type { Block } from './schema';
import { collectImageUrls, imageKey, imageUpstreamUrl, rewriteImageSrc } from './image-url';

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

  it('drops query strings (not part of the R2 key)', () => {
    // A `?` in the key would read as a query on a custom-domain direct-serve.
    expect(rewriteImageSrc('https://cache.hiroba.dqx.jp/a.jpg?v=2')).toBe('/img/cache.hiroba.dqx.jp/a.jpg');
  });

  it('accepts a custom base for serving straight from a bucket domain', () => {
    expect(rewriteImageSrc('https://cache.hiroba.dqx.jp/a.jpg', 'https://img.example.com')).toBe(
      'https://img.example.com/cache.hiroba.dqx.jp/a.jpg',
    );
    expect(rewriteImageSrc('/dq_resource/a.jpg', 'https://img.example.com')).toBe(
      'https://img.example.com/cache.hiroba.dqx.jp/dq_resource/a.jpg',
    );
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

describe('imageKey', () => {
  it('keys mirrorable DQX images (query-less), canonicalizing aliases', () => {
    expect(imageKey('https://cache.hiroba.dqx.jp/dq_resource/a.jpg')).toBe('cache.hiroba.dqx.jp/dq_resource/a.jpg');
    expect(imageKey('https://hiroba.dqx.jp/dq_resource/a.jpg')).toBe('cache.hiroba.dqx.jp/dq_resource/a.jpg');
    expect(imageKey('/dq_resource/a.jpg?v=2')).toBe('cache.hiroba.dqx.jp/dq_resource/a.jpg');
    expect(imageKey('https://faceicon.dqx.jp/i/x.jpg')).toBe('faceicon.dqx.jp/i/x.jpg');
  });

  it('returns null for non-mirrorable srcs', () => {
    expect(imageKey('https://www.ganganonline.com/x.jpg')).toBeNull();
    expect(imageKey('/img/cache.hiroba.dqx.jp/a.jpg')).toBeNull();
    expect(imageKey('data:image/png;base64,AAAA')).toBeNull();
    expect(imageKey('/assets/local.png')).toBeNull();
    expect(imageKey('')).toBeNull();
  });

  it('round-trips to the upstream URL', () => {
    const key = imageKey('https://hiroba.dqx.jp/dq_resource/a.jpg');
    expect(key).not.toBeNull();
    expect(imageUpstreamUrl(key!)).toBe('https://cache.hiroba.dqx.jp/dq_resource/a.jpg');
  });
});

describe('collectImageUrls', () => {
  it('gathers block images (+ sources), inline icons, and portraits; deduped', () => {
    const blocks: Block[] = [
      {
        type: 'image',
        src: 'https://cache.hiroba.dqx.jp/a.jpg',
        sources: [{ src: 'https://cache.hiroba.dqx.jp/a@2x.jpg' }],
      },
      {
        type: 'paragraph',
        children: [
          'see ',
          { type: 'icon', src: '/dq_resource/ico_2nd.gif' },
          { type: 'link', href: '#', children: [{ type: 'icon', src: '/dq_resource/ico_3rd.gif' }] },
        ],
      },
      {
        type: 'speechBubble',
        icon: 'https://faceicon.dqx.jp/p.jpg',
        children: [{ type: 'image', src: 'https://cache.hiroba.dqx.jp/a.jpg' }], // dupe
      },
    ];

    const urls = collectImageUrls(blocks);
    expect(new Set(urls)).toEqual(
      new Set([
        'https://cache.hiroba.dqx.jp/a.jpg',
        'https://cache.hiroba.dqx.jp/a@2x.jpg',
        '/dq_resource/ico_2nd.gif',
        '/dq_resource/ico_3rd.gif',
        'https://faceicon.dqx.jp/p.jpg',
      ]),
    );
    // 'a.jpg' appeared twice in the tree but is collected once.
    expect(urls.filter((u) => u === 'https://cache.hiroba.dqx.jp/a.jpg')).toHaveLength(1);
  });
});
