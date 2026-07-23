import { eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getItemTitles,
  getRecheckQueue,
  saveChangedBody,
  setBodyChecked,
  upsertListItems,
  upsertTopic,
} from './queries';
import { withLocalizedTitle } from './relations';
import { newsItems, type ListItem } from './schema/news-items';
import { topics } from './schema/topics';
import {
  setTranslationStates,
  upsertItemTranslation,
} from './schema/translations.queries';
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

/**
 * The news list-page recipe (apps/web [lang]/index + category pages): cursor
 * pagination over db.query with the `title` relation flattened by withLocalizedTitle.
 * Duplicated here so the relation's join semantics and the pagination recipe
 * stay pinned against real D1.
 */
async function listNews(
  options: {
    category?: string;
    limit?: number;
    cursor?: string;
    language?: string;
  } = {},
) {
  const limit = options.limit ?? 20;
  const rows = await ctx.db.query.newsItems.findMany({
    where: {
      ...(options.category ? { category: options.category } : {}),
      ...(options.cursor
        ? { publishedAt: { lt: Temporal.Instant.from(options.cursor) } }
        : {}),
    },
    with: {
      title: {
        where: { language: options.language ?? 'en' },
        columns: { value: true },
      },
    },
    orderBy: { publishedAt: 'desc' },
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(withLocalizedTitle);
  return {
    items,
    hasMore,
    nextCursor: hasMore
      ? items[items.length - 1].publishedAt.toString()
      : undefined,
  };
}

describe('upsertListItems', () => {
  it('inserts new items and returns them all as newly inserted', async () => {
    const items = [listItem(1, 1), listItem(2, 2), listItem(3, 3)];

    const inserted = await upsertListItems(ctx.db, items);

    expect(inserted.map((i) => i.id).sort()).toEqual(
      items.map((i) => i.id).sort(),
    );
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

    await upsertListItems(ctx.db, [{ ...listItem(1, 1), titleJa: '書き換え' }]);

    const row = await ctx.db
      .select()
      .from(newsItems)
      .where(eq(newsItems.id, hex(1)))
      .get();
    expect(row?.titleJa).toBe('記事1');
  });
});

describe('news list recipe (cursor pagination)', () => {
  beforeEach(async () => {
    // 5 items, publishedAt strictly increasing with index (index 5 is newest).
    await upsertListItems(
      ctx.db,
      [1, 2, 3, 4, 5].map((i) => listItem(i, i)),
    );
  });

  it('orders newest-first and reports hasMore + nextCursor when truncated', async () => {
    const page = await listNews({ limit: 2 });

    expect(page.items.map((i) => i.id)).toEqual([hex(5), hex(4)]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(page.items[1].publishedAt.toString());
  });

  it('walks the full list across pages without gaps or overlap', async () => {
    const first = await listNews({ limit: 2 });
    const second = await listNews({
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await listNews({
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
    const page = await listNews({ cursor });

    expect(page.items.map((i) => i.id)).toEqual([hex(2), hex(1)]);
  });

  it('filters by category', async () => {
    await ctx.db.insert(newsItems).values({
      id: hex(99),
      titleJa: 'イベント',
      category: 'event',
      publishedAt: BASE.add({ hours: 99 }),
    });

    const news = await listNews({ category: 'news' });
    const events = await listNews({ category: 'event' });

    expect(news.items).toHaveLength(5);
    expect(events.items.map((i) => i.id)).toEqual([hex(99)]);
  });
});

describe('news list title relation (DQX-11)', () => {
  beforeEach(async () => {
    await upsertListItems(ctx.db, [listItem(1, 1), listItem(2, 2)]);
  });

  it('surfaces localizedTitle when a title translation exists, null otherwise', async () => {
    await upsertItemTranslation(ctx.db, {
      itemType: 'news',
      itemId: hex(2),
      language: 'en',
      field: 'title',
      value: 'Article Two',
      model: 'gemini-x',
    });

    const { items } = await listNews();
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get(hex(2))?.localizedTitle).toBe('Article Two');
    expect(byId.get(hex(1))?.localizedTitle).toBeNull();
    // titleJa always rides along for the fallback.
    expect(byId.get(hex(2))?.titleJa).toBe('記事2');
  });

  it('scopes the join to the requested language', async () => {
    await upsertItemTranslation(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      field: 'title',
      value: 'English',
      model: 'm',
    });

    const en = await listNews({ language: 'en' });
    const fr = await listNews({ language: 'fr' });
    expect(en.items.find((i) => i.id === hex(1))?.localizedTitle).toBe(
      'English',
    );
    expect(fr.items.find((i) => i.id === hex(1))?.localizedTitle).toBeNull();
  });

  it('joins only the title field, never content', async () => {
    await upsertItemTranslation(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      field: 'content',
      value: '[]',
      model: 'm',
    });
    const { items } = await listNews();
    expect(items.find((i) => i.id === hex(1))?.localizedTitle).toBeNull();
  });

  it('surfaces a stale value while a re-translation is running', async () => {
    await upsertItemTranslation(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      field: 'title',
      value: 'Stale',
      model: 'm',
    });
    await setTranslationStates(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      fields: ['title'],
      state: 'running',
    });
    const { items } = await listNews();
    expect(items.find((i) => i.id === hex(1))?.localizedTitle).toBe('Stale');
  });

  it('does not multiply rows when several translation fields exist', async () => {
    for (const field of ['title', 'content'] as const) {
      await upsertItemTranslation(ctx.db, {
        itemType: 'news',
        itemId: hex(1),
        language: 'en',
        field,
        value: field === 'content' ? '[]' : 'T',
        model: 'm',
      });
    }
    const { items } = await listNews();
    expect(items.filter((i) => i.id === hex(1))).toHaveLength(1);
    expect(items.find((i) => i.id === hex(1))?.localizedTitle).toBe('T');
  });
});

describe('topics list title relation (DQX-11)', () => {
  it('surfaces localizedTitle when present, null otherwise', async () => {
    await upsertTopic(ctx.db, {
      id: hex(1),
      titleJa: 'トピック1',
      publishedAt: BASE.add({ hours: 1 }),
    });
    await upsertTopic(ctx.db, {
      id: hex(2),
      titleJa: 'トピック2',
      publishedAt: BASE.add({ hours: 2 }),
    });
    await upsertItemTranslation(ctx.db, {
      itemType: 'topic',
      itemId: hex(1),
      language: 'en',
      field: 'title',
      value: 'Topic One',
      model: 'm',
    });

    const rows = await ctx.db.query.topics.findMany({
      with: { title: { where: { language: 'en' }, columns: { value: true } } },
      orderBy: { publishedAt: 'desc' },
    });
    const byId = new Map(rows.map(withLocalizedTitle).map((t) => [t.id, t]));
    expect(byId.get(hex(1))?.localizedTitle).toBe('Topic One');
    expect(byId.get(hex(2))?.localizedTitle).toBeNull();
  });
});

describe('getItemTitles', () => {
  it('returns {id, titleJa} for existing ids and omits missing ones', async () => {
    await upsertListItems(ctx.db, [listItem(1, 1), listItem(2, 2)]);

    const rows = await getItemTitles(ctx.db, 'news', [hex(1), hex(2), hex(3)]);
    const byId = new Map(rows.map((r) => [r.id, r.titleJa]));

    expect(byId.get(hex(1))).toBe('記事1');
    expect(byId.get(hex(2))).toBe('記事2');
    expect(byId.has(hex(3))).toBe(false); // never inserted
  });

  it('reads from the topics table for itemType=topic', async () => {
    await upsertTopic(ctx.db, {
      id: hex(1),
      titleJa: 'トピック1',
      publishedAt: BASE,
    });
    const rows = await getItemTitles(ctx.db, 'topic', [hex(1)]);
    expect(rows).toEqual([{ id: hex(1), titleJa: 'トピック1' }]);
  });

  it('is a no-op for an empty id list', async () => {
    expect(await getItemTitles(ctx.db, 'news', [])).toEqual([]);
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

    const row = await ctx.db
      .select()
      .from(topics)
      .where(eq(topics.id, id))
      .get();
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

    const row = await ctx.db
      .select()
      .from(topics)
      .where(eq(topics.id, id))
      .get();
    expect(row?.blocksJa).toEqual(newBlocks);
  });
});

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
