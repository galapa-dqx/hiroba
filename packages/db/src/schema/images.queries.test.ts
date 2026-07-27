import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test-db';
import {
  ensureImageSourceRows,
  getImageSourcesByKeys,
} from './image-sources.queries';
import {
  getRenderWithSource,
  getServedImages,
  insertImageRender,
  replaceDerivedFiles,
} from './images.queries';

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

describe('IN-list chunking (D1 variable cap)', () => {
  it('handles image sets far beyond 100 bound parameters', async () => {
    const keys = Array.from({ length: 130 }, (_, i) => `host/img-${i}.png`);

    await ensureImageSourceRows(ctx.db, keys);
    const rows = await getImageSourcesByKeys(ctx.db, keys);
    expect(rows).toHaveLength(130);
    expect(new Set(rows.map((r) => r.key)).size).toBe(130);

    // Give the first 5 sources a localized render, then read all 130 back
    // through the chunked serving query.
    for (const row of rows.slice(0, 5)) {
      await insertImageRender(ctx.db, {
        id: crypto.randomUUID(),
        sourceId: row.id,
        language: 'en',
        model: 'gpt-image-2',
        files: [
          {
            key: `l10n/en/${row.key}`,
            isPrimary: true,
            mime: 'image/png',
            width: 10,
            height: 10,
            bytes: 100,
          },
        ],
      });
    }
    const served = await getServedImages(
      ctx.db,
      rows.map((r) => r.id),
      'en',
    );
    expect(served.size).toBe(130);
    const localized = [...served.values()].filter((v) => v.localized);
    expect(localized).toHaveLength(5);
  });
});

/** One source with one localized render carrying a primary + AVIF file.
 *  `id` is injectable because renderIsNewer ties equal-millisecond renders on
 *  id — back-to-back inserts in one test routinely share a wall-clock ms, and
 *  two random UUIDs would decide "newest" by coin flip. */
async function seedRender(
  files: Parameters<typeof insertImageRender>[1]['files'],
  id = crypto.randomUUID(),
): Promise<{ sourceId: number; imageId: string }> {
  await ensureImageSourceRows(ctx.db, ['host/a.png']);
  const [source] = await getImageSourcesByKeys(ctx.db, ['host/a.png']);
  await insertImageRender(ctx.db, {
    id,
    sourceId: source!.id,
    language: 'en',
    model: 'gpt-image-2',
    files,
  });
  return { sourceId: source!.id, imageId: id };
}

const PRIMARY = {
  key: 'l10n/en/v1/host/a.png',
  isPrimary: true,
  mime: 'image/png',
  width: 800,
  height: 600,
  bytes: 1000,
};
const AVIF = {
  key: 'l10n/en/v1/host/a.png.avif',
  isPrimary: false,
  mime: 'image/avif',
  width: 800,
  height: 600,
  bytes: 300,
};

describe('serving a render with derived files', () => {
  it('returns the primary broken out from the rest of the file set', async () => {
    const { sourceId } = await seedRender([PRIMARY, AVIF]);

    const served = await getServedImages(ctx.db, [sourceId], 'en');
    const render = served.get(sourceId)?.localized;

    expect(render?.primary).toEqual({
      key: PRIMARY.key,
      mime: 'image/png',
      width: 800,
      height: 600,
    });
    expect(render?.derived).toEqual([
      { key: AVIF.key, mime: 'image/avif', width: 800, height: 600 },
    ]);
  });

  it('serves only the newest render, files and all', async () => {
    // Deterministic ids ordered v1 < v2: the inserts routinely land in the
    // same millisecond, where renderIsNewer falls back to the id tiebreak.
    const { sourceId } = await seedRender(
      [PRIMARY, AVIF],
      '00000000-0000-4000-8000-000000000001',
    );
    // A regeneration: fresh versioned key, fresh render, latest-wins.
    await insertImageRender(ctx.db, {
      id: '00000000-0000-4000-8000-000000000002',
      sourceId,
      language: 'en',
      model: 'manual',
      files: [{ ...PRIMARY, key: 'l10n/en/v2/host/a.png' }],
    });

    const render = (await getServedImages(ctx.db, [sourceId], 'en')).get(
      sourceId,
    )?.localized;

    expect(render?.primary.key).toBe('l10n/en/v2/host/a.png');
    // The superseded render's AVIF must not leak into the new one's <picture>.
    expect(render?.derived).toEqual([]);
  });
});

describe('getRenderWithSource', () => {
  it('joins a render to its source key and primary file', async () => {
    const { imageId } = await seedRender([PRIMARY, AVIF]);

    expect(await getRenderWithSource(ctx.db, imageId)).toEqual({
      id: imageId,
      language: 'en',
      sourceKey: 'host/a.png',
      primary: {
        key: PRIMARY.key,
        mime: 'image/png',
        width: 800,
        height: 600,
      },
    });
  });

  it('is null for an unknown id', async () => {
    expect(await getRenderWithSource(ctx.db, crypto.randomUUID())).toBeNull();
  });
});

describe('replaceDerivedFiles', () => {
  it('adds derived rows without touching the primary', async () => {
    const { sourceId, imageId } = await seedRender([PRIMARY]);

    const stale = await replaceDerivedFiles(ctx.db, imageId, [AVIF]);

    expect(stale).toEqual([]);
    const render = (await getServedImages(ctx.db, [sourceId], 'en')).get(
      sourceId,
    )?.localized;
    expect(render?.primary.key).toBe(PRIMARY.key);
    expect(render?.derived.map((f) => f.key)).toEqual([AVIF.key]);
  });

  it('retires rows a later pass no longer produces, and reports their keys', async () => {
    const { sourceId, imageId } = await seedRender([PRIMARY, AVIF]);

    // A re-run whose fit rendition survived but whose full AVIF did not.
    const rendition = {
      key: 'l10n/en/v1/host/a.png.fit400x400.avif',
      isPrimary: false,
      mime: 'image/avif',
      width: 400,
      height: 300,
      bytes: 90,
    };
    const stale = await replaceDerivedFiles(ctx.db, imageId, [rendition]);

    expect(stale).toEqual([AVIF.key]);
    const render = (await getServedImages(ctx.db, [sourceId], 'en')).get(
      sourceId,
    )?.localized;
    expect(render?.derived.map((f) => f.key)).toEqual([rendition.key]);
    expect(render?.primary.key).toBe(PRIMARY.key);
  });

  it('drops every derived row when a pass produces none', async () => {
    const { sourceId, imageId } = await seedRender([PRIMARY, AVIF]);

    expect(await replaceDerivedFiles(ctx.db, imageId, [])).toEqual([AVIF.key]);
    const render = (await getServedImages(ctx.db, [sourceId], 'en')).get(
      sourceId,
    )?.localized;
    expect(render?.derived).toEqual([]);
    expect(render?.primary.key).toBe(PRIMARY.key);
  });
});
