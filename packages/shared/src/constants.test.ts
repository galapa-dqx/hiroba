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

  it('leaves unknown content types untouched', () => {
    expect(keyWithExtension('host/a.jpg', 'image/tiff')).toBe('host/a.jpg');
  });
});

describe('avifVariantKey', () => {
  it('appends .avif so derivation never collides across originals', () => {
    expect(avifVariantKey('host/a.jpg')).toBe('host/a.jpg.avif');
    expect(avifVariantKey('l10n/en/v123/host/a.png')).toBe(
      'l10n/en/v123/host/a.png.avif',
    );
  });
});

describe('fitVariantKey', () => {
  it('names by the requested box with a truthful extension', () => {
    const size = { width: 640, height: 480 };
    expect(fitVariantKey('host/a.png', size, 'image/png')).toBe(
      'host/a.png.fit640x480.png',
    );
    expect(fitVariantKey('host/a.png', size, 'image/avif')).toBe(
      'host/a.png.fit640x480.avif',
    );
  });
});

describe('localizedImageKey', () => {
  it('keeps the source extension when no content type is given', () => {
    expect(localizedImageKey('en', '123', 'host/a.jpg')).toBe(
      'l10n/en/v123/host/a.jpg',
    );
  });

  it('corrects the extension to the render content type', () => {
    expect(localizedImageKey('en', '123', 'host/a.jpg', 'image/png')).toBe(
      'l10n/en/v123/host/a.png',
    );
  });
});
