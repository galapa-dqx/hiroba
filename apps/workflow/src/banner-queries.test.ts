import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { banners } from '@hiroba/db';
import { createTestDb, type TestDb } from '@hiroba/db/test-db';

import { syncBanners, type BannerListItem } from './banner-queries';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.dispose();
});
beforeEach(async () => {
  await ctx.reset();
  // reset() doesn't wipe banners (not in its table list), so clear it here.
  await ctx.db.delete(banners);
});

const item = (key: string, sortOrder = 0): BannerListItem => ({
  imageKey: key,
  linkUrl: null,
  linkTopicId: null,
  altJa: 'バナー',
  sortOrder,
  publishedAt: null,
});

const activeMap = async () => {
  const rows = await ctx.db.select().from(banners).all();
  return new Map(rows.map((r) => [r.imageKey, r.active]));
};

describe('syncBanners', () => {
  it('upserts the rotation as active and deactivates departed banners', async () => {
    await syncBanners(ctx.db, [item('host/a.png', 0), item('host/b.png', 1)]);
    expect(await activeMap()).toEqual(
      new Map([
        ['host/a.png', true],
        ['host/b.png', true],
      ]),
    );

    // b leaves the rotation, c appears: b flips inactive but its row (and any
    // localized images keyed off it) survives for a re-appearance.
    await syncBanners(ctx.db, [item('host/a.png', 0), item('host/c.png', 1)]);
    expect(await activeMap()).toEqual(
      new Map([
        ['host/a.png', true],
        ['host/b.png', false],
        ['host/c.png', true],
      ]),
    );
  });

  it('re-activates a returning banner and updates its metadata in place', async () => {
    await syncBanners(ctx.db, [item('host/a.png', 0)]);
    await syncBanners(ctx.db, []); // empty rotation deactivates everything
    expect(await activeMap()).toEqual(new Map([['host/a.png', false]]));

    await syncBanners(ctx.db, [
      { ...item('host/a.png', 3), altJa: '新バナー' },
    ]);
    const rows = await ctx.db.select().from(banners).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true);
    expect(rows[0].sortOrder).toBe(3);
    expect(rows[0].altJa).toBe('新バナー');
  });
});
