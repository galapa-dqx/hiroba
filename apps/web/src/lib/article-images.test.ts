/**
 * resolveRender — which recorded files a served render may offer the browser.
 * The rule the rest of the pipeline leans on: ONLY full-size encoding
 * alternates become `<picture>` sources, because a `<source>` without srcset
 * descriptors is a 1x candidate.
 */

import { describe, expect, it } from 'vitest';

import type { ServedRender } from '@hiroba/db';

import { resolveRender } from './article-images';

const PRIMARY = {
  key: 'l10n/en/v1/host/a.png',
  mime: 'image/png',
  width: 800,
  height: 600,
};

const render = (derived: ServedRender['derived']): ServedRender => ({
  primary: PRIMARY,
  derived,
});

describe('resolveRender', () => {
  it('serves the primary with its measured dimensions', () => {
    expect(resolveRender(render([]), '/img')).toEqual({
      src: '/img/l10n/en/v1/host/a.png',
      width: 800,
      height: 600,
    });
  });

  it('offers a same-dimension alternate encoding as a <picture> source', () => {
    const resolved = resolveRender(
      render([
        {
          key: `${PRIMARY.key}.avif`,
          mime: 'image/avif',
          width: 800,
          height: 600,
        },
      ]),
      '/img',
    );

    expect(resolved.sources).toEqual([
      { src: `/img/${PRIMARY.key}.avif`, type: 'image/avif' },
    ]);
  });

  it('never offers a fit rendition — it would serve shrunken bytes at full size', () => {
    const resolved = resolveRender(
      render([
        {
          key: `${PRIMARY.key}.fit400x400.avif`,
          mime: 'image/avif',
          width: 400,
          height: 300,
        },
      ]),
      '/img',
    );

    expect(resolved.sources).toBeUndefined();
  });

  it('never offers a file whose dimensions were never measured', () => {
    const resolved = resolveRender(
      render([
        {
          key: `${PRIMARY.key}.avif`,
          mime: 'image/avif',
          width: null,
          height: null,
        },
      ]),
      '/img',
    );

    expect(resolved.sources).toBeUndefined();
  });

  it('orders alternates best-encoding-first — the browser takes the first hit', () => {
    const resolved = resolveRender(
      render([
        {
          key: `${PRIMARY.key}.webp`,
          mime: 'image/webp',
          width: 800,
          height: 600,
        },
        {
          key: `${PRIMARY.key}.avif`,
          mime: 'image/avif',
          width: 800,
          height: 600,
        },
      ]),
      '/img',
    );

    expect(resolved.sources?.map((s) => s.type)).toEqual([
      'image/avif',
      'image/webp',
    ]);
  });
});
