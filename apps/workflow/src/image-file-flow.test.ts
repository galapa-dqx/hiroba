/**
 * ImageFileFlow body on the fast inline tier: the derived files an already-
 * written render gets, and the purge that follows. The contract under test is
 * "degrade, never throw" — a vanished render or object records nothing, and
 * the run still completes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getRenderWithSource, replaceDerivedFiles } from '@hiroba/db';
import { runFlowInline } from '@hiroba/flow';
import { ImageFileFlow } from '@hiroba/flows';

import { runImageFileFlow, type ImageFileFlowEnv } from './image-file-flow';
import { buildDerivedFiles } from './image-files';
import { purgeImagePages } from './purge';

vi.mock('@hiroba/db', () => ({
  createDb: vi.fn(() => ({})),
  getRenderWithSource: vi.fn(),
  replaceDerivedFiles: vi.fn(),
}));

vi.mock('./image-files', () => ({ buildDerivedFiles: vi.fn() }));
vi.mock('./purge', () => ({ purgeImagePages: vi.fn() }));

const IMAGE_ID = '4a1c0a5e-0000-4000-8000-000000000001';
const SOURCE_KEY = 'cache.hiroba.dqx.jp/dq_resource/img/hero.png';
const RENDER_KEY = 'l10n/en/v1abc/cache.hiroba.dqx.jp/dq_resource/img/hero.png';

const bucket = {
  get: vi.fn(),
  delete: vi.fn(),
};
const env = {
  DB: {},
  IMAGES_BUCKET: bucket,
  IMAGES: {},
  WEB_BASE_URL: 'https://example.com',
} as unknown as ImageFileFlowEnv;

const run = () =>
  runFlowInline(
    ImageFileFlow,
    (f, params) => runImageFileFlow(f, params, env),
    { imageId: IMAGE_ID },
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRenderWithSource).mockResolvedValue({
    id: IMAGE_ID,
    language: 'en',
    sourceKey: SOURCE_KEY,
    primary: {
      key: RENDER_KEY,
      mime: 'image/png',
      width: 800,
      height: 600,
    },
  });
  bucket.get.mockResolvedValue({
    arrayBuffer: async () => new ArrayBuffer(8),
    httpMetadata: { contentType: 'image/png', cacheControl: 'immutable-ish' },
  });
  vi.mocked(buildDerivedFiles).mockResolvedValue([
    {
      key: `${RENDER_KEY}.avif`,
      isPrimary: false,
      mime: 'image/avif',
      width: 800,
      height: 600,
      bytes: 300,
    },
  ]);
  vi.mocked(replaceDerivedFiles).mockResolvedValue([]);
});

describe('image file flow — derived files for one written render', () => {
  it('encodes from the render primary, records the rows, then purges', async () => {
    const result = await run();

    expect(result.error).toBeUndefined();
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.output).toEqual({ imageId: IMAGE_ID, files: 1 });

    expect(bucket.get).toHaveBeenCalledWith(RENDER_KEY);
    // The stored object's own cache-control is carried onto its derived files.
    expect(vi.mocked(buildDerivedFiles)).toHaveBeenCalledWith(
      env.IMAGES,
      env.IMAGES_BUCKET,
      RENDER_KEY,
      expect.any(Uint8Array),
      'immutable-ish',
    );
    expect(vi.mocked(replaceDerivedFiles)).toHaveBeenCalledWith(
      expect.anything(),
      IMAGE_ID,
      [expect.objectContaining({ key: `${RENDER_KEY}.avif` })],
    );
    // Purged by the SOURCE key + language — the versioned render key isn't
    // reversible to the pages embedding the image. A real logger rides along:
    // purge.ts reports every failure path through log?.warn, so passing none
    // makes a rotated token or missing zone config silently strand caches.
    expect(vi.mocked(purgeImagePages)).toHaveBeenCalledWith(
      env,
      expect.anything(),
      SOURCE_KEY,
      'en',
      expect.objectContaining({ warn: expect.any(Function) }),
    );
  });

  it('deletes the objects of rows a re-run retired', async () => {
    vi.mocked(replaceDerivedFiles).mockResolvedValue([`${RENDER_KEY}.stale`]);

    await run();

    // Rows first, then their objects — an orphaned object is benign debris, a
    // row pointing at nothing is not.
    expect(bucket.delete).toHaveBeenCalledWith([`${RENDER_KEY}.stale`]);
  });

  it('records nothing but still purges when the object has vanished', async () => {
    bucket.get.mockResolvedValue(null);

    const result = await run();

    expect(result.output).toEqual({ imageId: IMAGE_ID, files: 0 });
    expect(vi.mocked(replaceDerivedFiles)).not.toHaveBeenCalled();
    expect(vi.mocked(purgeImagePages)).toHaveBeenCalled();
  });

  it('completes without purging when the render row is gone', async () => {
    vi.mocked(getRenderWithSource).mockResolvedValue(null);

    const result = await run();

    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe('complete');
    expect(result.output).toEqual({ imageId: IMAGE_ID, files: 0 });
    expect(vi.mocked(purgeImagePages)).not.toHaveBeenCalled();
  });

  it('skips the purge for a mirrored original — it has no per-language pages', async () => {
    vi.mocked(getRenderWithSource).mockResolvedValue({
      id: IMAGE_ID,
      language: null,
      sourceKey: SOURCE_KEY,
      primary: { key: SOURCE_KEY, mime: 'image/png', width: 8, height: 8 },
    });

    const result = await run();

    expect(result.output).toEqual({ imageId: IMAGE_ID, files: 1 });
    expect(vi.mocked(purgeImagePages)).not.toHaveBeenCalled();
  });

  it('lets an infrastructure failure escape so the engine retries', async () => {
    // The render row is already committed before the flow starts, so a throw
    // costs nothing — swallowing it would memoize the step as a permanent
    // files:0 success with no later pass to recover.
    bucket.get.mockRejectedValue(new Error('R2 unavailable'));

    const result = await run();

    expect(result.error).toBeDefined();
    expect(vi.mocked(replaceDerivedFiles)).not.toHaveBeenCalled();
  });

  it('keeps the previous pass rows when this pass derived nothing', async () => {
    // Zero files is ambiguous — legitimately nothing, or an Images outage
    // failing every encode. Retiring rows on the latter would 404 <source>
    // URLs cached HTML still embeds, so an empty set must not touch the db.
    vi.mocked(buildDerivedFiles).mockResolvedValue([]);

    const result = await run();

    expect(result.output).toEqual({ imageId: IMAGE_ID, files: 0 });
    expect(vi.mocked(replaceDerivedFiles)).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('completes despite a throwing purge — best-effort by contract', async () => {
    vi.mocked(purgeImagePages).mockRejectedValue(new Error('D1 blip'));

    const result = await run();

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ imageId: IMAGE_ID, files: 1 });
  });
});
