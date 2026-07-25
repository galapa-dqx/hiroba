import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  saveChangedBody,
  updateNewsBlocks,
  updatePlayguideBlocks,
  updateTopicBlocks,
  upsertListItems,
  upsertTopic,
} from '../queries';
import { createTestDb, type TestDb } from '../test-db';
import { banners } from './banners';
import { type ListItem } from './news-items';

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

const BASE = Temporal.Instant.from('2026-01-01T00:00:00Z');
const hex = (n: number) => n.toString(16).padStart(32, '0');

/** Build a ListItem with publishedAt = BASE + `hoursOld`, newest = highest. */
function listItem(index: number, hoursOld: number): ListItem {
  return {
    id: hex(index),
    titleJa: `記事${index}`,
    category: 'news',
    publishedAt: BASE.add({ hours: hoursOld }),
  };
}

describe('article_images reverse index', () => {
  const SRC_A = 'https://cache.hiroba.dqx.jp/dq_resource/img/a.png';
  const SRC_B = 'https://cache.hiroba.dqx.jp/dq_resource/img/b.png';
  const KEY_A = 'cache.hiroba.dqx.jp/dq_resource/img/a.png';
  const KEY_B = 'cache.hiroba.dqx.jp/dq_resource/img/b.png';

  /** Read the reverse index directly — the shape the purge fan-out consumes. */
  const articlesFor = (key: string) =>
    ctx.db.query.articleImages.findMany({
      columns: { itemType: true, itemId: true },
      where: { imageKey: key },
    });
  const isBanner = async (key: string) =>
    !!(await ctx.db.query.banners.findFirst({ where: { imageKey: key } }));

  it('syncs on upsert, replaces on rewrite, answers reverse lookups', async () => {
    await upsertTopic(ctx.db, {
      id: hex(1),
      titleJa: 'トピック1',
      publishedAt: BASE,
      blocksJa: [
        { type: 'image', src: SRC_A },
        { type: 'image', src: SRC_A }, // duplicates collapse
        { type: 'image', src: SRC_B },
      ],
    });

    expect(await articlesFor(KEY_A)).toEqual([
      { itemType: 'topic', itemId: hex(1) },
    ]);

    // A rewrite that drops an image replaces the set, not appends to it.
    await updateTopicBlocks(ctx.db, hex(1), [{ type: 'image', src: SRC_B }]);
    expect(await articlesFor(KEY_A)).toEqual([]);
    expect(await articlesFor(KEY_B)).toEqual([
      { itemType: 'topic', itemId: hex(1) },
    ]);

    // A metadata-only upsert (no blocksJa) must not clear the index.
    await upsertTopic(ctx.db, {
      id: hex(1),
      titleJa: 'トピック1改',
      publishedAt: BASE,
    });
    expect(await articlesFor(KEY_B)).toEqual([
      { itemType: 'topic', itemId: hex(1) },
    ]);
  });

  it('flags banner images for the home-page purge', async () => {
    // Direct insert — syncBanners lives with its flow in apps/workflow now.
    await ctx.db.insert(banners).values({
      imageKey: KEY_A,
      altJa: 'バナー',
      sortOrder: 0,
      updatedAt: BASE,
    });
    expect(await isBanner(KEY_A)).toBe(true);
    expect(await isBanner(KEY_B)).toBe(false);
  });

  it('syncs when a recheck saves a changed body', async () => {
    await upsertTopic(ctx.db, {
      id: hex(3),
      titleJa: 'トピック3',
      publishedAt: BASE,
      blocksJa: [{ type: 'image', src: SRC_A }],
    });

    // The recheck poll finds changed content with a different image set.
    await saveChangedBody(ctx.db, 'topic', hex(3), {
      blocks: [{ type: 'image', src: SRC_B }],
    });
    expect(await articlesFor(KEY_A)).toEqual([]);
    expect(await articlesFor(KEY_B)).toEqual([
      { itemType: 'topic', itemId: hex(3) },
    ]);

    // A save against a nonexistent article must not plant ghost index rows.
    await saveChangedBody(ctx.db, 'topic', hex(4), {
      blocks: [{ type: 'image', src: SRC_A }],
    });
    expect(await articlesFor(KEY_A)).toEqual([]);
  });

  it('syncs news blocks via updateNewsBlocks', async () => {
    await upsertListItems(ctx.db, [listItem(5, 1)]);
    await updateNewsBlocks(ctx.db, hex(5), [{ type: 'image', src: SRC_A }]);
    expect(await articlesFor(KEY_A)).toEqual([
      { itemType: 'news', itemId: hex(5) },
    ]);
  });

  it('block updates against nonexistent ids plant no ghost rows', async () => {
    const blocks = [{ type: 'image' as const, src: SRC_A }];
    await updateNewsBlocks(ctx.db, hex(90), blocks);
    await updateTopicBlocks(ctx.db, hex(91), blocks);
    await updatePlayguideBlocks(ctx.db, 'no-such-guide', blocks);
    expect(await articlesFor(KEY_A)).toEqual([]);
  });
});
