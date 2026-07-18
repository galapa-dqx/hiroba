/**
 * registerImageSources against a scripted fake ImagesBinding — locks the
 * variant rules: full-size AVIF beside the primary, fit-inside renditions in
 * source format + AVIF per requested size, and the skips (raster already
 * inside the box, output no smaller than the primary, non-raster sources).
 * Also deleteImageSourceGroup's rows-then-objects contract.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteImageSourcesByGroup,
  insertImageSources,
  type Database,
} from '@hiroba/db';

import { deleteImageSourceGroup, registerImageSources } from './image-sources';

vi.mock('@hiroba/db', () => ({
  insertImageSources: vi.fn(),
  deleteImageSourcesByGroup: vi.fn(),
}));

const db = {} as Database;

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
 * A fake ImagesBinding driven by two queues: `info` results (first call
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

describe('registerImageSources', () => {
  it('records primary + full AVIF + fit renditions in both formats', async () => {
    const images = makeImages(
      [pngInfo(800, 600), pngInfo(400, 300), pngInfo(400, 300)],
      [pngBytes(300), pngBytes(500), pngBytes(200)],
    );
    const bucket = makeBucket();

    await registerImageSources(
      db,
      images,
      bucket,
      'g/a.png',
      pngBytes(1000),
      'cc',
      {
        sizes: [{ width: 400, height: 400 }],
      },
    );

    expect(vi.mocked(bucket.put).mock.calls.map((c) => c[0])).toEqual([
      'g/a.png.avif',
      'g/a.png.fit400x400.png',
      'g/a.png.fit400x400.avif',
    ]);
    expect(insertImageSources).toHaveBeenCalledWith(db, [
      expect.objectContaining({
        key: 'g/a.png',
        groupKey: 'g/a.png',
        mime: 'image/png',
        width: 800,
        height: 600,
        bytes: 1000,
      }),
      expect.objectContaining({
        key: 'g/a.png.avif',
        mime: 'image/avif',
        width: 800,
        height: 600,
        bytes: 300,
      }),
      expect.objectContaining({
        key: 'g/a.png.fit400x400.png',
        mime: 'image/png',
        width: 400,
        height: 300,
        bytes: 500,
      }),
      expect.objectContaining({
        key: 'g/a.png.fit400x400.avif',
        mime: 'image/avif',
        width: 400,
        height: 300,
        bytes: 200,
      }),
    ]);
  });

  it('skips a size the raster already fits inside', async () => {
    const images = makeImages([pngInfo(800, 600)], [pngBytes(300)]);
    const bucket = makeBucket();

    await registerImageSources(
      db,
      images,
      bucket,
      'g/a.png',
      pngBytes(1000),
      'cc',
      {
        sizes: [{ width: 1600, height: 1600 }],
      },
    );

    // Only the full-size AVIF — no fit renditions.
    expect(vi.mocked(bucket.put).mock.calls.map((c) => c[0])).toEqual([
      'g/a.png.avif',
    ]);
  });

  it('discards outputs that came out no smaller than the primary', async () => {
    const images = makeImages([pngInfo(800, 600)], [pngBytes(1000)]);
    const bucket = makeBucket();

    await registerImageSources(
      db,
      images,
      bucket,
      'g/a.png',
      pngBytes(1000),
      'cc',
    );

    expect(bucket.put).not.toHaveBeenCalled();
    expect(insertImageSources).toHaveBeenCalledWith(db, [
      expect.objectContaining({ key: 'g/a.png', mime: 'image/png' }),
    ]);
  });

  it('records only the primary row for sources it must not re-encode (GIF)', async () => {
    const images = makeImages(
      [{ format: 'image/gif', fileSize: 1, width: 100, height: 100 }],
      [],
    );
    const bucket = makeBucket();

    await registerImageSources(
      db,
      images,
      bucket,
      'g/a.gif',
      gifBytes(1000),
      'cc',
      {
        sizes: [{ width: 50, height: 50 }],
      },
    );

    expect(bucket.put).not.toHaveBeenCalled();
    expect(insertImageSources).toHaveBeenCalledWith(db, [
      expect.objectContaining({ key: 'g/a.gif', mime: 'image/gif' }),
    ]);
  });
});

describe('deleteImageSourceGroup', () => {
  it('removes the rows first, then their R2 objects in one bulk delete', async () => {
    vi.mocked(deleteImageSourcesByGroup).mockResolvedValue([
      'g/a.png',
      'g/a.png.avif',
    ]);
    const bucket = makeBucket();

    const removed = await deleteImageSourceGroup(db, bucket, 'g/a.png');

    expect(removed).toBe(2);
    expect(bucket.delete).toHaveBeenCalledWith(['g/a.png', 'g/a.png.avif']);
  });

  it('does not touch the bucket for an unrecorded group', async () => {
    vi.mocked(deleteImageSourcesByGroup).mockResolvedValue([]);
    const bucket = makeBucket();

    expect(await deleteImageSourceGroup(db, bucket, 'g/none')).toBe(0);
    expect(bucket.delete).not.toHaveBeenCalled();
  });
});
