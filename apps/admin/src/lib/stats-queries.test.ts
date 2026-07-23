import { eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  newsItems,
  translations,
  upsertListItems,
  upsertTopic,
  type ListItem,
} from '@hiroba/db';
import { createTestDb, type TestDb } from '@hiroba/db/test-db';

import { getStats } from './stats-queries';

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

describe('getStats', () => {
  it('aggregates per-type totals, translation counts, and category breakdown', async () => {
    await upsertListItems(ctx.db, [
      listItem(1, 1),
      listItem(2, 2),
      { ...listItem(3, 3), category: 'event' },
    ]);
    // Give item 1 a fetched body. BASE is months in the past, so its recheck
    // schedule is retired (quiet past the retirement horizon).
    await ctx.db
      .update(newsItems)
      .set({
        blocksJa: [{ type: 'paragraph', children: ['本文'] }],
        bodyFetchedAt: BASE,
        bodyCheckedAt: BASE,
      })
      .where(eq(newsItems.id, hex(1)));
    // Translate item 2's content.
    await ctx.db.insert(translations).values({
      itemType: 'news',
      itemId: hex(2),
      language: 'en',
      field: 'content',
      state: 'done',
      value: '[]',
      translatedAt: BASE,
      model: 'gpt-x',
      updatedAt: BASE,
    });
    // One topic with a body.
    await upsertTopic(ctx.db, {
      id: hex(9),
      titleJa: 'トピック',
      publishedAt: BASE,
      blocksJa: [{ type: 'paragraph', children: ['本文'] }],
      bodyFetchedAt: BASE,
    });

    const stats = await getStats(ctx.db);

    expect(stats.news.total).toBe(3);
    expect(stats.news.withBody).toBe(1);
    expect(stats.news.translated).toBe(1);
    expect(stats.news.byCategory).toEqual({ news: 2, event: 1 });
    expect(stats.news.recheckRetired).toBe(1);
    expect(stats.news.recheckDue).toBe(0);
    expect(stats.topics.total).toBe(1);
    expect(stats.topics.withBody).toBe(1);
    expect(stats.topics.translated).toBe(0);
    expect(stats.topics.recheckRetired).toBe(1);
  });
});
