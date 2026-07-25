import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test-db';
import {
  ensureImageSourceRows,
  getImageSourcesByKeys,
} from './image-sources.queries';
import { getServedImages, insertImageRender } from './images.queries';

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
