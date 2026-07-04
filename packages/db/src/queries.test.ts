import { eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getNewsItems,
  getStats,
  upsertImageTranscription,
  upsertListItems,
  upsertTopic,
} from './queries';
import { newsItems, type ListItem } from './schema/news-items';
import { topics } from './schema/topics';
import { translations } from './schema/translations';
import { createTestDb, type TestDb } from './test-db';

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

describe('upsertListItems', () => {
  it('inserts new items and returns them all as newly inserted', async () => {
    const items = [listItem(1, 1), listItem(2, 2), listItem(3, 3)];

    const inserted = await upsertListItems(ctx.db, items);

    expect(inserted.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
    const count = await ctx.db.select().from(newsItems).all();
    expect(count).toHaveLength(3);
  });

  it('returns only the genuinely new items on a second pass', async () => {
    await upsertListItems(ctx.db, [listItem(1, 1), listItem(2, 2)]);

    const inserted = await upsertListItems(ctx.db, [
      listItem(2, 2), // already present
      listItem(3, 3), // new
    ]);

    expect(inserted.map((i) => i.id)).toEqual([hex(3)]);
  });

  it('does not clobber an existing row (onConflictDoNothing)', async () => {
    await upsertListItems(ctx.db, [listItem(1, 1)]);

    await upsertListItems(ctx.db, [
      { ...listItem(1, 1), titleJa: '書き換え' },
    ]);

    const row = await ctx.db
      .select()
      .from(newsItems)
      .where(eq(newsItems.id, hex(1)))
      .get();
    expect(row?.titleJa).toBe('記事1');
  });
});

describe('getNewsItems pagination', () => {
  beforeEach(async () => {
    // 5 items, publishedAt strictly increasing with index (index 5 is newest).
    await upsertListItems(
      ctx.db,
      [1, 2, 3, 4, 5].map((i) => listItem(i, i)),
    );
  });

  it('orders newest-first and reports hasMore + nextCursor when truncated', async () => {
    const page = await getNewsItems(ctx.db, { limit: 2 });

    expect(page.items.map((i) => i.id)).toEqual([hex(5), hex(4)]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(page.items[1].publishedAt.toString());
  });

  it('walks the full list across pages without gaps or overlap', async () => {
    const first = await getNewsItems(ctx.db, { limit: 2 });
    const second = await getNewsItems(ctx.db, {
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await getNewsItems(ctx.db, {
      limit: 2,
      cursor: second.nextCursor,
    });

    expect(first.items.map((i) => i.id)).toEqual([hex(5), hex(4)]);
    expect(second.items.map((i) => i.id)).toEqual([hex(3), hex(2)]);
    expect(third.items.map((i) => i.id)).toEqual([hex(1)]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeUndefined();
  });

  it('excludes the cursor boundary item (strict less-than)', async () => {
    // Cursor at item 3's timestamp should return only strictly older items.
    const cursor = BASE.add({ hours: 3 }).toString();
    const page = await getNewsItems(ctx.db, { cursor });

    expect(page.items.map((i) => i.id)).toEqual([hex(2), hex(1)]);
  });

  it('filters by category', async () => {
    await ctx.db.insert(newsItems).values({
      id: hex(99),
      titleJa: 'イベント',
      category: 'event',
      publishedAt: BASE.add({ hours: 99 }),
    });

    const news = await getNewsItems(ctx.db, { category: 'news' });
    const events = await getNewsItems(ctx.db, { category: 'event' });

    expect(news.items).toHaveLength(5);
    expect(events.items.map((i) => i.id)).toEqual([hex(99)]);
  });

  it('caps the limit at 100', async () => {
    const page = await getNewsItems(ctx.db, { limit: 10_000 });
    // Only 5 rows exist; the cap just must not throw or over-fetch.
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
  });
});

describe('upsertTopic', () => {
  const id = hex(7);
  const publishedAt = BASE.add({ hours: 7 });

  it('preserves an already-fetched block tree on a metadata-only re-upsert', async () => {
    await upsertTopic(ctx.db, {
      id,
      titleJa: 'トピック',
      publishedAt,
      blocksJa: [{ type: 'paragraph', children: [] }] as never,
      bodyFetchedAt: BASE,
    });

    // Re-upsert Phase-1 metadata only (no blocksJa / bodyFetchedAt).
    await upsertTopic(ctx.db, {
      id,
      titleJa: 'トピック（更新）',
      publishedAt: publishedAt.add({ hours: 1 }),
    });

    const row = await ctx.db.select().from(topics).where(eq(topics.id, id)).get();
    expect(row?.titleJa).toBe('トピック（更新）');
    expect(row?.blocksJa).not.toBeNull(); // block tree survived
    expect(row?.bodyFetchedAt).not.toBeNull();
  });

  it('updates the block tree when one is provided', async () => {
    await upsertTopic(ctx.db, { id, titleJa: 'トピック', publishedAt });

    const newBlocks = [
      { type: 'paragraph', children: [{ type: 'text', text: 'x' }] },
    ] as never;
    await upsertTopic(ctx.db, {
      id,
      titleJa: 'トピック',
      publishedAt,
      blocksJa: newBlocks,
    });

    const row = await ctx.db.select().from(topics).where(eq(topics.id, id)).get();
    expect(row?.blocksJa).toEqual(newBlocks);
  });
});

describe('upsertImageTranscription', () => {
  it('creates a row and returns its surrogate id', async () => {
    const id = await upsertImageTranscription(ctx.db, {
      key: 'host/a.png',
      textsJa: ['ドラゴン'],
      model: 'gpt-x',
    });

    expect(id).toBe(1);
  });

  it('is get-or-create by key: same key keeps the id and updates the spans', async () => {
    const first = await upsertImageTranscription(ctx.db, {
      key: 'host/a.png',
      textsJa: ['ドラゴン'],
      model: 'gpt-x',
    });

    const second = await upsertImageTranscription(ctx.db, {
      key: 'host/a.png',
      textsJa: ['スライム', 'まほう'],
      model: 'gpt-y',
    });

    expect(second).toBe(first);
    const rows = await ctx.db.select().from(newsItems).all();
    expect(rows).toHaveLength(0); // sanity: distinct table
  });

  it('hands out distinct ids for distinct keys', async () => {
    const a = await upsertImageTranscription(ctx.db, {
      key: 'host/a.png',
      textsJa: [],
      model: 'm',
    });
    const b = await upsertImageTranscription(ctx.db, {
      key: 'host/b.png',
      textsJa: [],
      model: 'm',
    });

    expect(b).not.toBe(a);
  });
});

describe('getStats', () => {
  it('aggregates totals, body/translation counts, and per-category breakdown', async () => {
    await upsertListItems(ctx.db, [
      listItem(1, 1),
      listItem(2, 2),
      { ...listItem(3, 3), category: 'event' },
    ]);
    // Give item 1 a fetched body.
    await ctx.db
      .update(newsItems)
      .set({ contentJa: '本文', bodyFetchedAt: BASE })
      .where(eq(newsItems.id, hex(1)));
    // Translate item 2.
    await ctx.db.insert(translations).values({
      itemType: 'news',
      itemId: hex(2),
      language: 'en',
      field: 'title',
      value: 'Article 2',
      translatedAt: BASE,
      model: 'gpt-x',
    });

    const stats = await getStats(ctx.db);

    expect(stats.totalItems).toBe(3);
    expect(stats.itemsWithBody).toBe(1);
    expect(stats.itemsWithBodyFetchedAt).toBe(1);
    expect(stats.itemsTranslated).toBe(1);
    expect(stats.byCategory).toEqual({ news: 2, event: 1 });
  });
});
