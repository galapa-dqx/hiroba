import { eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newsItems, type ListItem } from '../schema/news-items';
import { topics } from '../schema/topics';
import { createTestDb, type TestDb } from '../test-db';
import { saveChangedBody, upsertListItems, upsertTopic } from './articles';
import { getRecheckQueue, setBodyChecked } from './recheck';

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

describe('recheck scheduling', () => {
  const BODY = [{ type: 'paragraph' as const, children: ['本文'] }];

  it('buckets due, upcoming and retired items across both types', async () => {
    const now = Temporal.Now.instant();
    const hoursAgo = (h: number) => now.subtract({ hours: h });

    // Due: published a day ago (interval 1h), last checked 2h ago.
    await upsertListItems(ctx.db, [
      { ...listItem(1, 0), publishedAt: hoursAgo(24) },
    ]);
    await ctx.db
      .update(newsItems)
      .set({
        blocksJa: BODY,
        bodyFetchedAt: hoursAgo(2),
        bodyCheckedAt: hoursAgo(2),
      })
      .where(eq(newsItems.id, hex(1)));

    // Upcoming: published a week ago (interval 7h), checked an hour ago.
    await upsertTopic(ctx.db, {
      id: hex(2),
      titleJa: 'トピック',
      publishedAt: hoursAgo(7 * 24),
      blocksJa: BODY,
      bodyFetchedAt: hoursAgo(1),
      bodyCheckedAt: hoursAgo(1),
    });

    // Retired: quiet for 90 days.
    await upsertTopic(ctx.db, {
      id: hex(3),
      titleJa: '古いトピック',
      publishedAt: hoursAgo(90 * 24),
      blocksJa: BODY,
      bodyFetchedAt: hoursAgo(30 * 24),
      bodyCheckedAt: hoursAgo(30 * 24),
    });

    const queue = await getRecheckQueue(ctx.db);

    expect(queue.due.map((e) => e.id)).toEqual([hex(1)]);
    expect(queue.due[0].itemType).toBe('news');
    expect(queue.upcoming.map((e) => e.id)).toEqual([hex(2)]);
    expect(queue.upcoming[0].itemType).toBe('topic');
    expect(queue.retired).toBe(1);
  });

  it('saveChangedBody resets the change anchor so checking speeds back up', async () => {
    const now = Temporal.Now.instant();
    // A month-old topic: interval ~30h.
    await upsertTopic(ctx.db, {
      id: hex(1),
      titleJa: 'トピック',
      publishedAt: now.subtract({ hours: 30 * 24 }),
      blocksJa: BODY,
      bodyFetchedAt: now.subtract({ hours: 1 }),
      bodyCheckedAt: now.subtract({ hours: 1 }),
    });

    let queue = await getRecheckQueue(ctx.db);
    const before = queue.upcoming.find((e) => e.id === hex(1))!;

    await saveChangedBody(ctx.db, 'topic', hex(1), {
      blocks: [{ type: 'paragraph', children: ['更新'] }],
      titleJa: '更新トピック',
    });

    queue = await getRecheckQueue(ctx.db);
    const after = queue.upcoming.find((e) => e.id === hex(1))!;

    // The change anchor moved to now, so the next check is much sooner
    // (min interval) than the pre-change schedule.
    expect(
      Temporal.Instant.compare(after.nextCheckAt!, before.nextCheckAt!),
    ).toBe(-1);
    expect(after.titleJa).toBe('更新トピック');

    const row = await ctx.db
      .select()
      .from(topics)
      .where(eq(topics.id, hex(1)))
      .get();
    expect(row!.bodyChangedAt).not.toBeNull();
    expect(row!.blocksJa).toEqual([{ type: 'paragraph', children: ['更新'] }]);
  });

  it('setBodyChecked pushes the next check out without touching the anchor', async () => {
    const now = Temporal.Now.instant();
    await upsertTopic(ctx.db, {
      id: hex(1),
      titleJa: 'トピック',
      publishedAt: now.subtract({ hours: 24 }),
      blocksJa: BODY,
      bodyFetchedAt: now.subtract({ hours: 2 }),
      bodyCheckedAt: now.subtract({ hours: 2 }),
    });

    let queue = await getRecheckQueue(ctx.db);
    expect(queue.due.map((e) => e.id)).toEqual([hex(1)]);

    await setBodyChecked(ctx.db, 'topic', hex(1));

    queue = await getRecheckQueue(ctx.db);
    expect(queue.due).toHaveLength(0);
    expect(queue.upcoming.map((e) => e.id)).toEqual([hex(1)]);
  });
});
