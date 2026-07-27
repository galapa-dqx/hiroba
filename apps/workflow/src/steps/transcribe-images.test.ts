/**
 * transcribeOneImage's done-check and its unloadable-image path, now that
 * `texts_ja` is the "transcribed" signal rather than a `transcribe_state`
 * column (DQX-46). The vision call itself is out of scope here — these cases
 * all settle before the model is ever reached.
 */

import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ensureImageSourceRows, imageSources } from '@hiroba/db';
import { createTestDb, type TestDb } from '@hiroba/db/test-db';

import type * as GeminiModule from '../gemini';
import { transcribeOneImage } from './transcribe-images';

// The client is constructed but never called: every case here settles before
// the vision request.
vi.mock('../gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof GeminiModule>()),
  createGemini: vi.fn(
    () => ({}) as ReturnType<typeof GeminiModule.createGemini>,
  ),
}));

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.dispose();
});
beforeEach(async () => {
  await ctx.reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks(); // the console.error spies some cases install
});

const KEY = 'cache.hiroba.dqx.jp/dq_resource/sign.png';

/** An R2 stand-in that holds nothing — forces the CDN fallback. */
const emptyBucket = {
  async get() {
    return null;
  },
} as unknown as R2Bucket;

const run = () => transcribeOneImage(ctx.db, KEY, 'test-key', emptyBucket);

const textsJaFor = async (key: string) =>
  (
    await ctx.db
      .select()
      .from(imageSources)
      .where(eq(imageSources.key, key))
      .get()
  )?.textsJa;

describe('transcribeOneImage', () => {
  it('says why when the image bytes cannot be loaded', async () => {
    await ensureImageSourceRows(ctx.db, [KEY]);
    // Not in the bucket and the CDN fallback 404s — loadByKey swallows both,
    // so the log is the only account of what went wrong.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await run()).toBe('failed');

    // texts_ja stays NULL, which is exactly what makes the next pass retry.
    expect(await textsJaFor(KEY)).toBeNull();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('image bytes unavailable'),
    );
  });

  it('skips a key that already has spans, without loading anything', async () => {
    await ensureImageSourceRows(ctx.db, [KEY]);
    await ctx.db
      .update(imageSources)
      .set({ textsJa: ['ドラゴン'] })
      .where(eq(imageSources.key, KEY));
    vi.stubGlobal('fetch', vi.fn());

    expect(await run()).toBe('skipped');

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(await textsJaFor(KEY)).toEqual(['ドラゴン']);
  });

  it('treats a text-free image ([]) as transcribed, not as pending work', async () => {
    await ensureImageSourceRows(ctx.db, [KEY]);
    await ctx.db
      .update(imageSources)
      .set({ textsJa: [] })
      .where(eq(imageSources.key, KEY));
    vi.stubGlobal('fetch', vi.fn());

    expect(await run()).toBe('skipped');

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});
