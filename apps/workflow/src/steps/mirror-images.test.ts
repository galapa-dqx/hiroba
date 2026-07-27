/**
 * mirrorOneImage's three paths, now that "mirrored" is the original render's
 * existence rather than a `mirror_state` column (DQX-46): skip on the render,
 * self-heal a render for bytes already in the bucket, and copy from upstream.
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

import {
  ensureImageSourceRows,
  imageFiles,
  imageSources,
  images as renders,
} from '@hiroba/db';
import { createTestDb, type TestDb } from '@hiroba/db/test-db';

import { mirrorOneImage } from './mirror-images';

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

const KEY = 'cache.hiroba.dqx.jp/dq_resource/banner.png';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A Map-backed R2 stand-in with just the surface the step touches. */
function fakeBucket(seed: Record<string, Uint8Array> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key: string) {
      const bytes = store.get(key);
      if (!bytes) return null;
      return {
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
        httpMetadata: { contentType: 'image/png' },
      };
    },
    async put(key: string, bytes: Uint8Array) {
      store.set(key, bytes);
    },
  };
}

/** The Images binding, reporting fixed dimensions for anything handed to it. */
const fakeImages = {
  info: async () => ({ format: 'image/png', width: 64, height: 32 }),
} as unknown as ImagesBinding;

const run = (bucket: ReturnType<typeof fakeBucket>) =>
  mirrorOneImage(ctx.db, bucket as unknown as R2Bucket, fakeImages, KEY);

/** The source's original render (language NULL) with its primary file, if any. */
async function originalFile() {
  const rows = await ctx.db
    .select({ key: imageFiles.key, mime: imageFiles.mime, w: imageFiles.width })
    .from(renders)
    .innerJoin(imageFiles, eq(imageFiles.imageId, renders.id))
    .all();
  return rows[0] ?? null;
}

describe('mirrorOneImage', () => {
  it('copies from upstream and records the original render', async () => {
    await ensureImageSourceRows(ctx.db, [KEY]);
    const bucket = fakeBucket();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(PNG, { status: 200 })),
    );

    expect(await run(bucket)).toBe('mirrored');

    expect(bucket.store.has(KEY)).toBe(true);
    expect(await originalFile()).toMatchObject({
      key: KEY,
      mime: 'image/png',
      w: 64,
    });
  });

  it('skips without touching R2 once the original render exists', async () => {
    await ensureImageSourceRows(ctx.db, [KEY]);
    const bucket = fakeBucket();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(PNG, { status: 200 })),
    );
    await run(bucket);

    const get = vi.spyOn(bucket, 'get');
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockClear();

    expect(await run(bucket)).toBe('skipped');

    // The render row is the whole predicate — no R2 read, no upstream fetch…
    expect(get).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // …and no second original.
    expect(await ctx.db.select().from(renders).all()).toHaveLength(1);
  });

  it('self-heals a render for bytes already in the bucket', async () => {
    // The /img routes restore objects without touching D1, so R2 can be ahead
    // of the render table. Read the bytes back rather than re-fetching.
    await ensureImageSourceRows(ctx.db, [KEY]);
    const bucket = fakeBucket({ [KEY]: PNG });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(PNG, { status: 200 })),
    );

    expect(await run(bucket)).toBe('skipped');

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(await originalFile()).toMatchObject({ key: KEY, w: 64 });
  });

  it('degrades instead of throwing when the stored object is unreadable', async () => {
    // The self-heal path reads bytes back out of R2; a corrupted object must
    // come back as 'failed' like any other bad image, not escape the step.
    await ensureImageSourceRows(ctx.db, [KEY]);
    const bucket = fakeBucket({ [KEY]: PNG });
    bucket.get = async () => ({
      arrayBuffer: async () => {
        throw new Error('corrupt object');
      },
      httpMetadata: { contentType: 'image/png' },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await run(bucket)).toBe('failed');

    expect(await ctx.db.select().from(renders).all()).toEqual([]);
    // The thrown value is logged as-is, so an Error keeps its stack.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('Failed to mirror'),
      expect.objectContaining({ message: 'corrupt object' }),
    );
  });

  it('leaves no render when upstream fails, and says why', async () => {
    await ensureImageSourceRows(ctx.db, [KEY]);
    const bucket = fakeBucket();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await run(bucket)).toBe('failed');

    expect(await ctx.db.select().from(renders).all()).toEqual([]);
    // The source row survives — the next pass retries it.
    expect(await ctx.db.select().from(imageSources).all()).toHaveLength(1);
    // With no failed row left to inspect, the log is the only breadcrumb.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('Failed to mirror'),
    );
  });

  it('logs and degrades when a write throws mid-mirror', async () => {
    await ensureImageSourceRows(ctx.db, [KEY]);
    const bucket = fakeBucket();
    // An R2 put (or the render insert behind it) blowing up must not escape
    // the step — nor vanish silently.
    bucket.put = async () => {
      throw new Error('R2 exploded');
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(PNG, { status: 200 })),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await run(bucket)).toBe('failed');

    expect(await ctx.db.select().from(renders).all()).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('Failed to mirror'),
      expect.objectContaining({ message: 'R2 exploded' }),
    );
  });

  it('refuses to store a non-image body under an image key', async () => {
    await ensureImageSourceRows(ctx.db, [KEY]);
    const bucket = fakeBucket();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>error page</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );

    expect(await run(bucket)).toBe('failed');

    expect(bucket.store.size).toBe(0);
    expect(await ctx.db.select().from(renders).all()).toEqual([]);
  });
});
