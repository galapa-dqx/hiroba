/**
 * resolveRender — which recorded files a served render offers the browser, and
 * how. The rules the rest of the pipeline leans on: every format is offered as
 * a `w`-descriptor ladder paired with `sizes`, and a format only appears at all
 * if it reaches the primary's full width.
 */

import { describe, expect, it } from 'vitest';

import type { ServedRender } from '@hiroba/db';
import { renderBlocks } from '@hiroba/richtext';

import { CONTENT_COLUMN_SIZES, resolveRender } from './article-images';

const KEY = 'l10n/en/v1/host/a.png';
const PRIMARY = { key: KEY, mime: 'image/png', width: 800, height: 600 };

const file = (key: string, mime: string, width: number, height: number) => ({
  key,
  mime,
  width,
  height,
});

const render = (derived: ServedRender['derived']): ServedRender => ({
  primary: PRIMARY,
  derived,
});

/** A render with the full ladder the pipeline writes. */
const FULL = render([
  file(`${KEY}.avif`, 'image/avif', 800, 600),
  file(`${KEY}.fit400x300.png`, 'image/png', 400, 300),
  file(`${KEY}.fit400x300.avif`, 'image/avif', 400, 300),
  file(`${KEY}.fit200x150.png`, 'image/png', 200, 150),
  file(`${KEY}.fit200x150.avif`, 'image/avif', 200, 150),
]);

describe('resolveRender', () => {
  it('serves the primary with its measured dimensions', () => {
    expect(resolveRender(render([]), '/img')).toEqual({
      src: `/img/${KEY}`,
      width: 800,
      height: 600,
    });
  });

  it('builds a w-descriptor ladder per format, narrowest first', () => {
    const resolved = resolveRender(FULL, '/img');

    // The <img>'s own srcset covers the primary's format, primary included.
    expect(resolved.srcset).toBe(
      `/img/${KEY}.fit200x150.png 200w, /img/${KEY}.fit400x300.png 400w, /img/${KEY} 800w`,
    );
    expect(resolved.sources).toEqual([
      {
        type: 'image/avif',
        srcset:
          `/img/${KEY}.fit200x150.avif 200w, ` +
          `/img/${KEY}.fit400x300.avif 400w, ` +
          `/img/${KEY}.avif 800w`,
      },
    ]);
  });

  it('pairs every ladder with sizes — without it the browser takes the top rung', () => {
    expect(resolveRender(FULL, '/img').sizes).toBe(CONTENT_COLUMN_SIZES);
    expect(resolveRender(FULL, '/img', '50vw').sizes).toBe('50vw');
  });

  it('emits no sizes when there is no ladder to choose from', () => {
    expect(resolveRender(render([]), '/img').sizes).toBeUndefined();
    expect(resolveRender(render([]), '/img').srcset).toBeUndefined();
  });

  it('drops a format that never reaches full width — it would upscale', () => {
    // AVIF only shrank at the smaller rungs (the full-size one came out no
    // smaller than the PNG). A browser picking that <source> is committed to
    // it, so a 400w ceiling would render blurry at 800px.
    const resolved = resolveRender(
      render([
        file(`${KEY}.fit400x300.avif`, 'image/avif', 400, 300),
        file(`${KEY}.fit200x150.avif`, 'image/avif', 200, 150),
      ]),
      '/img',
    );

    expect(resolved.sources).toBeUndefined();
  });

  it('offers the primary format alone when it is the only one with rungs', () => {
    const resolved = resolveRender(
      render([file(`${KEY}.fit400x300.png`, 'image/png', 400, 300)]),
      '/img',
    );

    expect(resolved.srcset).toBe(
      `/img/${KEY}.fit400x300.png 400w, /img/${KEY} 800w`,
    );
    expect(resolved.sources).toBeUndefined();
    expect(resolved.sizes).toBe(CONTENT_COLUMN_SIZES);
  });

  it('orders alternates best-encoding-first — the browser takes the first hit', () => {
    const resolved = resolveRender(
      render([
        file(`${KEY}.webp`, 'image/webp', 800, 600),
        file(`${KEY}.avif`, 'image/avif', 800, 600),
      ]),
      '/img',
    );

    expect(resolved.sources?.map((s) => s.type)).toEqual([
      'image/avif',
      'image/webp',
    ]);
  });

  it('skips files whose dimensions were never measured', () => {
    const resolved = resolveRender(
      render([
        { key: `${KEY}.avif`, mime: 'image/avif', width: null, height: null },
      ]),
      '/img',
    );

    expect(resolved.sources).toBeUndefined();
    expect(resolved.srcset).toBeUndefined();
  });

  it('serves a bare <img> when the primary itself was never measured', () => {
    // Nothing to anchor the ladder to — a seeded row awaiting the backfill.
    const resolved = resolveRender(
      {
        primary: { key: KEY, mime: 'image/png', width: null, height: null },
        derived: [file(`${KEY}.avif`, 'image/avif', 800, 600)],
      },
      '/img',
    );

    expect(resolved).toEqual({
      src: `/img/${KEY}`,
      width: null,
      height: null,
    });
  });
});

/**
 * The two halves of the feature meet here: what resolveRender returns has to
 * be exactly what the renderer consumes. Unit tests on either side can both
 * pass while the shape between them drifts (a renamed field, a srcset the
 * renderer never reads), so assert the real markup once, end to end.
 */
describe('resolveRender → renderBlocks', () => {
  it('renders the full ladder as a <picture> with per-format srcsets', () => {
    const html = renderBlocks([{ type: 'image', src: 'upstream/a.png' }], {
      imageSrc: () => resolveRender(FULL, '/img'),
    });

    expect(html).toBe(
      '<picture>' +
        '<source type="image/avif" srcset="' +
        `/img/${KEY}.fit200x150.avif 200w, ` +
        `/img/${KEY}.fit400x300.avif 400w, ` +
        `/img/${KEY}.avif 800w" ` +
        `sizes="${CONTENT_COLUMN_SIZES}">` +
        `<img class="rt-image" src="/img/${KEY}" srcset="` +
        `/img/${KEY}.fit200x150.png 200w, ` +
        `/img/${KEY}.fit400x300.png 400w, ` +
        `/img/${KEY} 800w" ` +
        `sizes="${CONTENT_COLUMN_SIZES}" width="800" height="600" alt="">` +
        '</picture>',
    );
  });

  it('renders a bare <img> for a render with nothing derived', () => {
    const html = renderBlocks([{ type: 'image', src: 'upstream/a.png' }], {
      imageSrc: () => resolveRender(render([]), '/img'),
    });

    expect(html).toBe(
      `<img class="rt-image" src="/img/${KEY}" width="800" height="600" alt="">`,
    );
  });
});
