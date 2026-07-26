import { describe, expect, it } from 'vitest';

import {
  avifVariantKey,
  fitVariantKey,
  keyWithExtension,
  localizedImageKey,
} from './constants';

describe('keyWithExtension', () => {
  it('keeps a key whose extension already matches the content type', () => {
    expect(keyWithExtension('host/a.png', 'image/png')).toBe('host/a.png');
    expect(keyWithExtension('host/a.jpg', 'image/jpeg')).toBe('host/a.jpg');
    expect(keyWithExtension('host/a.PNG', 'image/png')).toBe('host/a.PNG');
  });

  it('swaps a lying extension for the canonical one', () => {
    expect(keyWithExtension('host/dir/a.jpg', 'image/png')).toBe(
      'host/dir/a.png',
    );
    expect(keyWithExtension('host/a.gif', 'image/webp')).toBe('host/a.webp');
    // Non-canonical spellings normalize too.
    expect(keyWithExtension('host/a.jpeg', 'image/jpeg')).toBe('host/a.jpg');
  });

  it('appends when the key has no extension', () => {
    expect(keyWithExtension('host/dir/a', 'image/png')).toBe('host/dir/a.png');
  });

  it('is not fooled by dots in earlier path segments', () => {
    expect(keyWithExtension('cache.hiroba.dqx.jp/dir/a', 'image/png')).toBe(
      'cache.hiroba.dqx.jp/dir/a.png',
    );
  });

  it('throws on an unknown content type rather than minting a lying URL', () => {
    expect(() => keyWithExtension('host/a.jpg', 'image/tiff')).toThrow(
      /no canonical extension/,
    );
  });
});

describe('avifVariantKey', () => {
  it('appends rather than swapping, so siblings never collide', () => {
    expect(avifVariantKey('host/a.jpg')).toBe('host/a.jpg.avif');
    expect(avifVariantKey('host/a.png')).toBe('host/a.png.avif');
    expect(avifVariantKey('host/a.jpg')).not.toBe(avifVariantKey('host/a.png'));
  });
});

describe('fitVariantKey', () => {
  it('names the rendition by its requested box and output format', () => {
    expect(
      fitVariantKey('host/a.jpg', { width: 320, height: 240 }, 'image/jpeg'),
    ).toBe('host/a.jpg.fit320x240.jpg');
    expect(
      fitVariantKey('host/a.jpg', { width: 320, height: 240 }, 'image/avif'),
    ).toBe('host/a.jpg.fit320x240.avif');
  });

  it('throws on an unknown output type', () => {
    expect(() =>
      fitVariantKey('host/a.jpg', { width: 10, height: 10 }, 'image/tiff'),
    ).toThrow(/no canonical extension/);
  });
});

describe('localizedImageKey', () => {
  it('corrects the extension to the render content type', () => {
    expect(localizedImageKey('en', '123', 'host/a.jpg', 'image/png')).toBe(
      'l10n/en/v123/host/a.png',
    );
  });

  it('keeps an already-truthful extension', () => {
    expect(localizedImageKey('en', '123', 'host/a.png', 'image/png')).toBe(
      'l10n/en/v123/host/a.png',
    );
  });
});
