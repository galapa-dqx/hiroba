/**
 * buildRenderFiles against a scripted fake ImagesBinding — locks the derived
 * file rules: a full-size AVIF beside the primary, fit-inside renditions in
 * source format + AVIF per requested size, and the skips (a raster already
 * inside the box, an output no smaller than the primary, a non-raster source).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDerivedFiles, buildRenderFiles } from './image-files';

/** Bytes with a real PNG magic so sniffMimeType sees a raster. */
const pngBytes = (length: number): Uint8Array => {
  const b = new Uint8Array(length);
  b.set([0x89, 0x50, 0x4e, 0x47]);
  return b;
};

/** Bytes with a GIF magic — the "never re-encode" source. */
const gifBytes = (length: number): Uint8Array => {
  const b = new Uint8Array(length);
  b.set([0x47, 0x49, 0x46]);
  return b;
};

/**
 * A fake ImagesBinding driven by two queues: `info` results (the first call
 * measures the primary, later calls measure resized outputs) and transform
 * `outputs` (consumed in encode order: full AVIF, then per size
 * source-format → AVIF).
 */
const makeImages = (info: unknown[], outputs: Uint8Array[]) => {
  const output = vi.fn(async () => ({
    response: () => new Response(outputs.shift()),
  }));
  return {
    info: vi.fn(async () => {
      const next = info.shift();
      if (!next) throw new Error('unmeasurable');
      return next;
    }),
    input: vi.fn(() => ({
      output,
      transform: vi.fn(() => ({ output })),
    })),
  } as unknown as ImagesBinding;
};

const makeBucket = () =>
  ({ put: vi.fn(), delete: vi.fn() }) as unknown as R2Bucket;

const pngInfo = (width: number, height: number) => ({
  format: 'image/png',
  fileSize: 1,
  width,
  height,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildRenderFiles', () => {
  it('returns primary + full AVIF + fit renditions in both formats', async () => {
    const images = makeImages(
      [pngInfo(800, 600), pngInfo(400, 300), pngInfo(400, 300)],
      [pngBytes(300), pngBytes(500), pngBytes(200)],
    );
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/a.png',
      pngBytes(1000),
      'cc',
      { sizes: [{ width: 400, height: 400 }] },
    );

    // Objects land before the rows that name them.
    expect(vi.mocked(bucket.put).mock.calls.map((c) => c[0])).toEqual([
      'g/a.png.avif',
      'g/a.png.fit400x400.png',
      'g/a.png.fit400x400.avif',
    ]);
    expect(files).toEqual([
      {
        key: 'g/a.png',
        isPrimary: true,
        mime: 'image/png',
        width: 800,
        height: 600,
        bytes: 1000,
      },
      {
        key: 'g/a.png.avif',
        isPrimary: false,
        mime: 'image/avif',
        // The full-size AVIF inherits the primary's measurement.
        width: 800,
        height: 600,
        bytes: 300,
      },
      {
        key: 'g/a.png.fit400x400.png',
        isPrimary: false,
        mime: 'image/png',
        // Renditions are re-measured — Cloudflare owns the scale-down rounding.
        width: 400,
        height: 300,
        bytes: 500,
      },
      {
        key: 'g/a.png.fit400x400.avif',
        isPrimary: false,
        mime: 'image/avif',
        width: 400,
        height: 300,
        bytes: 200,
      },
    ]);
  });

  it('drops an encode that came out no smaller than the primary', async () => {
    const images = makeImages([pngInfo(64, 64)], [pngBytes(900)]);
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/icon.png',
      pngBytes(800),
      'cc',
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.isPrimary).toBe(true);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('skips a box the raster already fits inside', async () => {
    const images = makeImages([pngInfo(320, 200)], [pngBytes(300)]);
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/a.png',
      pngBytes(1000),
      'cc',
      { sizes: [{ width: 400, height: 400 }] },
    );

    // The full-size AVIF still lands; the rendition would be a same-size
    // lossy re-encode, so it is never attempted.
    expect(files.map((f) => f.key)).toEqual(['g/a.png', 'g/a.png.avif']);
  });

  it('never re-encodes a GIF (animation) but still records the primary', async () => {
    const images = makeImages(
      [{ format: 'image/gif', fileSize: 1, width: 100, height: 100 }],
      [],
    );
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/a.gif',
      gifBytes(1000),
      'cc',
      { sizes: [{ width: 40, height: 40 }] },
    );

    expect(files).toEqual([
      {
        key: 'g/a.gif',
        isPrimary: true,
        mime: 'image/gif',
        width: 100,
        height: 100,
        bytes: 1000,
      },
    ]);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('records an undecodable primary with the caller-supplied fallback mime', async () => {
    // Empty info queue → the binding throws → measureImage returns nulls, and
    // the bytes have no sniffable magic either.
    const images = makeImages([], []);
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/a.svg',
      new Uint8Array([0x3c, 0x73, 0x76, 0x67]),
      'cc',
      { fallbackMime: 'image/svg+xml' },
    );

    expect(files).toEqual([
      {
        key: 'g/a.svg',
        isPrimary: true,
        mime: 'image/svg+xml',
        width: null,
        height: null,
        bytes: 4,
      },
    ]);
  });

  it('survives a failing encode — the render just serves as a bare <img>', async () => {
    const images = {
      info: vi.fn(async () => pngInfo(800, 600)),
      input: vi.fn(() => ({
        output: vi.fn(async () => {
          throw new Error('transform unavailable');
        }),
      })),
    } as unknown as ImagesBinding;
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/a.png',
      pngBytes(1000),
      'cc',
    );

    expect(files.map((f) => f.key)).toEqual(['g/a.png']);
  });
});

describe('buildDerivedFiles', () => {
  it('returns only the derived rows, for a render whose primary already exists', async () => {
    const images = makeImages([pngInfo(800, 600)], [pngBytes(300)]);
    const bucket = makeBucket();

    const files = await buildDerivedFiles(
      images,
      bucket,
      'l10n/en/v1/g/a.png',
      pngBytes(1000),
      'cc',
    );

    expect(files).toEqual([
      {
        key: 'l10n/en/v1/g/a.png.avif',
        isPrimary: false,
        mime: 'image/avif',
        width: 800,
        height: 600,
        bytes: 300,
      },
    ]);
  });
});
