import { eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureImageRows,
  failPipelineStates,
  getImagesByKeys,
  getImageTranslations,
  getImageTranslationStates,
  getItemTitles,
  getNewsItems,
  getStats,
  getTopics,
  getTranslationStates,
  resetRunningTitles,
  setImageTranscribeState,
  setItemFetchState,
  setTranslationStates,
  upsertImageTranscription,
  upsertImageTranslation,
  upsertItemTranslation,
  upsertListItems,
  upsertTopic,
  upsertTopicTranslation,
} from './queries';
import { images } from './schema/images';
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

describe('getNewsItems current-language title join (DQX-11)', () => {
  beforeEach(async () => {
    await upsertListItems(ctx.db, [listItem(1, 1), listItem(2, 2)]);
  });

  it('surfaces titleEn when a title translation exists, null otherwise', async () => {
    await upsertItemTranslation(ctx.db, {
      itemType: 'news',
      itemId: hex(2),
      language: 'en',
      field: 'title',
      value: 'Article Two',
      model: 'gemini-x',
    });

    const { items } = await getNewsItems(ctx.db, {});
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get(hex(2))?.titleEn).toBe('Article Two');
    expect(byId.get(hex(1))?.titleEn).toBeNull();
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

    const en = await getNewsItems(ctx.db, { language: 'en' });
    const fr = await getNewsItems(ctx.db, { language: 'fr' });
    expect(en.items.find((i) => i.id === hex(1))?.titleEn).toBe('English');
    expect(fr.items.find((i) => i.id === hex(1))?.titleEn).toBeNull();
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
    const { items } = await getNewsItems(ctx.db, {});
    expect(items.find((i) => i.id === hex(1))?.titleEn).toBeNull();
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
    const { items } = await getNewsItems(ctx.db, {});
    expect(items.find((i) => i.id === hex(1))?.titleEn).toBe('Stale');
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
    const { items } = await getNewsItems(ctx.db, {});
    expect(items.filter((i) => i.id === hex(1))).toHaveLength(1);
    expect(items.find((i) => i.id === hex(1))?.titleEn).toBe('T');
  });
});

describe('getTopics current-language title join (DQX-11)', () => {
  it('surfaces titleEn when present, null otherwise', async () => {
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

    const { items } = await getTopics(ctx.db, {});
    const byId = new Map(items.map((t) => [t.id, t]));
    expect(byId.get(hex(1))?.titleEn).toBe('Topic One');
    expect(byId.get(hex(2))?.titleEn).toBeNull();
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

describe('resetRunningTitles', () => {
  it('resets running title rows to pending but leaves done untouched', async () => {
    await setTranslationStates(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      fields: ['title'],
      state: 'running',
    });
    await upsertItemTranslation(ctx.db, {
      itemType: 'news',
      itemId: hex(2),
      language: 'en',
      field: 'title',
      value: 'Done',
      model: 'm',
    });

    await resetRunningTitles(ctx.db, 'news', [hex(1), hex(2)], 'en');

    const running = await getTranslationStates(ctx.db, 'news', hex(1), 'en', [
      'title',
    ]);
    expect(running.get('title')).toBe('pending');
    const done = await getTranslationStates(ctx.db, 'news', hex(2), 'en', [
      'title',
    ]);
    expect(done.get('title')).toBe('done'); // not clobbered
  });

  it('does not touch the content field', async () => {
    await setTranslationStates(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      fields: ['content'],
      state: 'running',
    });
    await resetRunningTitles(ctx.db, 'news', [hex(1)], 'en');
    const states = await getTranslationStates(ctx.db, 'news', hex(1), 'en', [
      'content',
    ]);
    expect(states.get('content')).toBe('running');
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
      .set({
        blocksJa: [{ type: 'paragraph', children: ['本文'] }],
        bodyFetchedAt: BASE,
      })
      .where(eq(newsItems.id, hex(1)));
    // Translate item 2.
    await ctx.db.insert(translations).values({
      itemType: 'news',
      itemId: hex(2),
      language: 'en',
      field: 'title',
      state: 'done',
      value: 'Article 2',
      translatedAt: BASE,
      model: 'gpt-x',
      updatedAt: BASE,
    });

    const stats = await getStats(ctx.db);

    expect(stats.totalItems).toBe(3);
    expect(stats.itemsWithBody).toBe(1);
    expect(stats.itemsWithBodyFetchedAt).toBe(1);
    expect(stats.itemsTranslated).toBe(1);
    expect(stats.byCategory).toEqual({ news: 2, event: 1 });
  });
});

describe('pipeline state transitions', () => {
  it('tracks fetch state on items and backfills done via the fetched-body path', async () => {
    await upsertListItems(ctx.db, [listItem(1, 1)]);

    await setItemFetchState(ctx.db, 'news', hex(1), 'running');
    let row = await ctx.db
      .select()
      .from(newsItems)
      .where(eq(newsItems.id, hex(1)))
      .get();
    expect(row?.fetchState).toBe('running');

    await setItemFetchState(ctx.db, 'news', hex(1), 'done');
    row = await ctx.db
      .select()
      .from(newsItems)
      .where(eq(newsItems.id, hex(1)))
      .get();
    expect(row?.fetchState).toBe('done');
  });

  it('creates translation rows on first touch and reports missing rows as pending', async () => {
    const states = await getTranslationStates(ctx.db, 'topic', hex(1), 'en', [
      'title',
      'content',
    ]);
    expect(states.get('title')).toBe('pending');
    expect(states.get('content')).toBe('pending');

    await setTranslationStates(ctx.db, {
      itemType: 'topic',
      itemId: hex(1),
      language: 'en',
      fields: ['title', 'content'],
      state: 'running',
    });
    const running = await getTranslationStates(ctx.db, 'topic', hex(1), 'en', [
      'title',
      'content',
    ]);
    expect(running.get('title')).toBe('running');
    expect(running.get('content')).toBe('running');
  });

  it('keeps the previous value when a re-translation flips state to running', async () => {
    await upsertTopicTranslation(ctx.db, {
      itemId: hex(1),
      language: 'en',
      field: 'title',
      value: 'First pass',
      model: 'gpt-x',
    });

    await setTranslationStates(ctx.db, {
      itemType: 'topic',
      itemId: hex(1),
      language: 'en',
      fields: ['title'],
      state: 'running',
    });

    const row = await ctx.db.select().from(translations).get();
    expect(row?.state).toBe('running');
    expect(row?.value).toBe('First pass'); // stale-while-revalidate
  });

  it('records failure details and clears them on the next successful upsert', async () => {
    await setTranslationStates(ctx.db, {
      itemType: 'topic',
      itemId: hex(1),
      language: 'en',
      fields: ['title'],
      state: 'failed',
      error: 'model exploded',
    });
    let row = await ctx.db.select().from(translations).get();
    expect(row?.state).toBe('failed');
    expect(row?.error).toBe('model exploded');
    expect(row?.value).toBeNull();

    await upsertTopicTranslation(ctx.db, {
      itemId: hex(1),
      language: 'en',
      field: 'title',
      value: 'Recovered',
      model: 'gpt-x',
    });
    row = await ctx.db.select().from(translations).get();
    expect(row?.state).toBe('done');
    expect(row?.error).toBeNull();
    expect(row?.value).toBe('Recovered');
  });

  it('rejects done rows without a value (CHECK constraint)', async () => {
    await expect(
      ctx.db.insert(translations).values({
        itemType: 'topic',
        itemId: hex(1),
        language: 'en',
        field: 'title',
        state: 'done',
        updatedAt: BASE,
      }),
    ).rejects.toThrow();
  });

  it('failPipelineStates settles running fetch + in-flight translations, not done ones', async () => {
    await upsertListItems(ctx.db, [listItem(1, 1)]);
    await setItemFetchState(ctx.db, 'news', hex(1), 'running');
    await setTranslationStates(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      fields: ['title'],
      state: 'running',
    });
    // A finished row from an earlier run must survive.
    await ctx.db.insert(translations).values({
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      field: 'content',
      state: 'done',
      value: '[]',
      translatedAt: BASE,
      model: 'gpt-x',
      updatedAt: BASE,
    });

    await failPipelineStates(
      ctx.db,
      'news',
      hex(1),
      'en',
      'step exhausted retries',
    );

    const item = await ctx.db
      .select()
      .from(newsItems)
      .where(eq(newsItems.id, hex(1)))
      .get();
    expect(item?.fetchState).toBe('failed');

    const states = await getTranslationStates(ctx.db, 'news', hex(1), 'en', [
      'title',
      'content',
    ]);
    expect(states.get('title')).toBe('failed');
    expect(states.get('content')).toBe('done');
  });

  it('tracks image discovery and transcription state', async () => {
    await ensureImageRows(ctx.db, ['host/a.png', 'host/b.png']);
    // Idempotent — a second discovery pass must not reset anything.
    await setImageTranscribeState(ctx.db, 'host/a.png', 'running');
    await ensureImageRows(ctx.db, ['host/a.png']);

    let rows = await ctx.db.select().from(images).all();
    expect(rows.map((r) => r.transcribeState).sort()).toEqual([
      'pending',
      'running',
    ]);

    await upsertImageTranscription(ctx.db, {
      key: 'host/a.png',
      textsJa: ['テキスト'],
      model: 'gemini',
    });
    rows = await ctx.db.select().from(images).all();
    const a = rows.find((r) => r.key === 'host/a.png');
    expect(a?.transcribeState).toBe('done');
    expect(a?.textsJa).toEqual(['テキスト']);
  });
});

describe('IN-list chunking (D1 variable cap)', () => {
  it('handles image sets far beyond 100 bound parameters', async () => {
    const keys = Array.from({ length: 130 }, (_, i) => `host/img-${i}.png`);

    await ensureImageRows(ctx.db, keys);
    const rows = await getImagesByKeys(ctx.db, keys);
    expect(rows).toHaveLength(130);
    expect(new Set(rows.map((r) => r.key)).size).toBe(130);

    // Give every image a done url translation, then read them all back.
    for (const row of rows.slice(0, 5)) {
      await upsertImageTranslation(ctx.db, {
        imageId: row.id,
        language: 'en',
        field: 'url',
        value: `l10n/en/${row.key}`,
        model: 'gpt-image-2',
      });
    }
    const states = await getImageTranslationStates(
      ctx.db,
      rows.map((r) => r.id),
      'en',
      'url',
    );
    expect(states.size).toBe(5);
    expect([...states.values()].every((s) => s === 'done')).toBe(true);

    const urls = await getImageTranslations(
      ctx.db,
      rows.map((r) => r.id),
      'en',
      'url',
    );
    expect(urls.size).toBe(5);
  });
});
