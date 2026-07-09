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
  getRecheckQueue,
  getStats,
  getTitleTranslations,
  getTopics,
  getTranslationStates,
  getUntranslatedTitles,
  listImagesForAdmin,
  listWorkflowRuns,
  pruneWorkflowRuns,
  recordWorkflowRun,
  resetRunningTitles,
  resetRunningTitlesForLanguage,
  saveChangedBody,
  setBodyChecked,
  setImageTranscribeState,
  setItemFetchState,
  setTranslationStates,
  updateWorkflowRunStatus,
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

describe('getUntranslatedTitles (DQX-13 backfill scan)', () => {
  it('returns items lacking a title value, excluding done, newest-first', async () => {
    // publishedAt: item3 newest (BASE+3h) → item1 oldest (BASE+1h).
    await upsertListItems(ctx.db, [
      listItem(1, 1),
      listItem(2, 2),
      listItem(3, 3),
    ]);
    // Item 2 is fully translated (has a value) → excluded.
    await upsertItemTranslation(ctx.db, {
      itemType: 'news',
      itemId: hex(2),
      language: 'en',
      field: 'title',
      value: 'Done',
      model: 'm',
    });
    // Item 3 has an in-flight row with no value yet → still needs backfill.
    await setTranslationStates(ctx.db, {
      itemType: 'news',
      itemId: hex(3),
      language: 'en',
      fields: ['title'],
      state: 'running',
    });

    const rows = await getUntranslatedTitles(ctx.db, 'news', 'en');
    expect(rows).toEqual([
      { id: hex(3), titleJa: '記事3' }, // newest untranslated
      { id: hex(1), titleJa: '記事1' },
    ]);
  });

  it('scopes to the requested language', async () => {
    await upsertListItems(ctx.db, [listItem(1, 1)]);
    // Translated in English, but French is what we scan for.
    await upsertItemTranslation(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      field: 'title',
      value: 'Done',
      model: 'm',
    });

    expect(await getUntranslatedTitles(ctx.db, 'news', 'en')).toEqual([]);
    expect(await getUntranslatedTitles(ctx.db, 'news', 'fr')).toEqual([
      { id: hex(1), titleJa: '記事1' },
    ]);
  });

  it('honors the limit and advances as titles are translated (no cursor)', async () => {
    await upsertListItems(ctx.db, [
      listItem(1, 1),
      listItem(2, 2),
      listItem(3, 3),
    ]);

    // Newest two first.
    const page1 = await getUntranslatedTitles(ctx.db, 'news', 'en', 2);
    expect(page1.map((r) => r.id)).toEqual([hex(3), hex(2)]);

    // Translating the newest drops it from the set; the next scan returns the
    // next-newest page — no cursor threading needed.
    await upsertItemTranslation(ctx.db, {
      itemType: 'news',
      itemId: hex(3),
      language: 'en',
      field: 'title',
      value: 'Done',
      model: 'm',
    });
    const page2 = await getUntranslatedTitles(ctx.db, 'news', 'en', 2);
    expect(page2.map((r) => r.id)).toEqual([hex(2), hex(1)]);
  });

  it('reads from the topics table for itemType=topic', async () => {
    await upsertTopic(ctx.db, {
      id: hex(1),
      titleJa: 'トピック1',
      publishedAt: BASE,
    });
    expect(await getUntranslatedTitles(ctx.db, 'topic', 'en')).toEqual([
      { id: hex(1), titleJa: 'トピック1' },
    ]);
  });
});

describe('resetRunningTitlesForLanguage (DQX-13 backfill cleanup)', () => {
  it('resets running titles for the language across item types, sparing others', async () => {
    // News title running in en → should reset.
    await setTranslationStates(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      fields: ['title'],
      state: 'running',
    });
    // Topic title running in en → should reset (both item types swept).
    await setTranslationStates(ctx.db, {
      itemType: 'topic',
      itemId: hex(2),
      language: 'en',
      fields: ['title'],
      state: 'running',
    });
    // Another language, running → untouched.
    await setTranslationStates(ctx.db, {
      itemType: 'news',
      itemId: hex(3),
      language: 'fr',
      fields: ['title'],
      state: 'running',
    });
    // Done in en → keeps its value.
    await upsertItemTranslation(ctx.db, {
      itemType: 'news',
      itemId: hex(4),
      language: 'en',
      field: 'title',
      value: 'Done',
      model: 'm',
    });
    // Content field in en, running → not a title, untouched.
    await setTranslationStates(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      fields: ['content'],
      state: 'running',
    });

    await resetRunningTitlesForLanguage(ctx.db, 'en');

    const news = await getTranslationStates(ctx.db, 'news', hex(1), 'en', [
      'title',
      'content',
    ]);
    expect(news.get('title')).toBe('pending');
    expect(news.get('content')).toBe('running'); // not a title
    const topic = await getTranslationStates(ctx.db, 'topic', hex(2), 'en', [
      'title',
    ]);
    expect(topic.get('title')).toBe('pending');
    const fr = await getTranslationStates(ctx.db, 'news', hex(3), 'fr', [
      'title',
    ]);
    expect(fr.get('title')).toBe('running'); // other language untouched
    const done = await getTranslationStates(ctx.db, 'news', hex(4), 'en', [
      'title',
    ]);
    expect(done.get('title')).toBe('done'); // not clobbered
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

describe('listImagesForAdmin', () => {
  it('returns every image newest-first with no cursor', async () => {
    // Seed 5 images (ids 1..5 in insertion order).
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await upsertImageTranscription(ctx.db, {
          key: `host/img-${i}.png`,
          textsJa: i % 2 === 0 ? [`日本語${i}`] : [],
          model: 'gpt-vision',
        }),
      );
    }

    const { rows, hasMore, nextCursor } = await listImagesForAdmin(ctx.db, {
      language: 'en',
    });

    // No cursor must not silently filter everything out (regression: an absent
    // cursor once collapsed to id 0).
    expect(rows).toHaveLength(5);
    expect(hasMore).toBe(false);
    expect(nextCursor).toBeUndefined();
    // Newest (highest id) first.
    expect(rows.map((r) => r.image.id)).toEqual([...ids].reverse());
  });

  it('paginates via the id cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await upsertImageTranscription(ctx.db, {
        key: `host/page-${i}.png`,
        textsJa: [],
        model: 'gpt-vision',
      });
    }

    const first = await listImagesForAdmin(ctx.db, {
      language: 'en',
      limit: 2,
    });
    expect(first.rows).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(first.rows[1].image.id);

    const second = await listImagesForAdmin(ctx.db, {
      language: 'en',
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.rows).toHaveLength(2);
    // Strictly older than the first page's last id — no overlap.
    expect(second.rows[0].image.id).toBeLessThan(first.nextCursor!);
  });

  it('attaches the text + url translation rows for the requested language only', async () => {
    const id = await upsertImageTranscription(ctx.db, {
      key: 'host/localized.png',
      textsJa: ['こんにちは'],
      model: 'gpt-vision',
    });
    await upsertImageTranslation(ctx.db, {
      imageId: id,
      language: 'en',
      field: 'text',
      value: JSON.stringify(['Hello']),
      model: 'gpt-4',
    });
    await upsertImageTranslation(ctx.db, {
      imageId: id,
      language: 'en',
      field: 'url',
      value: 'l10n/en/host/localized.png',
      model: 'gpt-image-2',
    });
    // A French row that must not leak into the English view.
    await upsertImageTranslation(ctx.db, {
      imageId: id,
      language: 'fr',
      field: 'url',
      value: 'l10n/fr/host/localized.png',
      model: 'gpt-image-2',
    });

    const en = await listImagesForAdmin(ctx.db, { language: 'en' });
    const row = en.rows.find((r) => r.image.id === id)!;
    expect(row.text?.value).toBe(JSON.stringify(['Hello']));
    expect(row.url?.value).toBe('l10n/en/host/localized.png');
    expect(row.url?.state).toBe('done');

    const fr = await listImagesForAdmin(ctx.db, { language: 'fr' });
    const frRow = fr.rows.find((r) => r.image.id === id)!;
    expect(frRow.url?.value).toBe('l10n/fr/host/localized.png');
    // No French text was translated → no text row yet.
    expect(frRow.text).toBeNull();
  });
});

describe('workflow run registry', () => {
  it('records, lists and reconciles runs', async () => {
    await recordWorkflowRun(ctx.db, {
      instanceId: 'wf-1',
      itemType: 'topic',
      itemId: hex(1),
    });
    await recordWorkflowRun(ctx.db, {
      instanceId: 'wf-2',
      itemType: 'news',
      itemId: hex(2),
    });

    let runs = await listWorkflowRuns(ctx.db);
    expect(runs.map((r) => r.instanceId).sort()).toEqual(['wf-1', 'wf-2']);
    expect(runs.every((r) => r.status === 'running')).toBe(true);

    // Recording the same instance again is a no-op (trigger retries).
    await recordWorkflowRun(ctx.db, {
      instanceId: 'wf-1',
      itemType: 'topic',
      itemId: hex(1),
    });
    expect((await listWorkflowRuns(ctx.db)).length).toBe(2);

    // A settled run drops out of the active-only listing…
    await updateWorkflowRunStatus(ctx.db, 'wf-2', 'errored', 'boom');
    runs = await listWorkflowRuns(ctx.db);
    expect(runs.map((r) => r.instanceId)).toEqual(['wf-1']);

    // …but stays visible with a settledSince window covering it.
    runs = await listWorkflowRuns(ctx.db, {
      settledSince: Temporal.Now.instant().subtract({ hours: 1 }),
    });
    expect(runs.length).toBe(2);
    const errored = runs.find((r) => r.instanceId === 'wf-2')!;
    expect(errored.status).toBe('errored');
    expect(errored.error).toBe('boom');
  });

  it('prunes only settled runs older than the horizon', async () => {
    await recordWorkflowRun(ctx.db, {
      instanceId: 'wf-active',
      itemType: 'news',
      itemId: hex(1),
    });
    await recordWorkflowRun(ctx.db, {
      instanceId: 'wf-settled',
      itemType: 'news',
      itemId: hex(2),
    });
    await updateWorkflowRunStatus(ctx.db, 'wf-settled', 'complete');

    // A cutoff in the future would prune anything settled — the active run
    // must survive regardless.
    await pruneWorkflowRuns(ctx.db, Temporal.Now.instant().add({ hours: 1 }));
    const runs = await listWorkflowRuns(ctx.db, {
      settledSince: Temporal.Instant.fromEpochMilliseconds(0),
    });
    expect(runs.map((r) => r.instanceId)).toEqual(['wf-active']);
  });
});

describe('getTitleTranslations', () => {
  it('returns only value-bearing title rows for the item type', async () => {
    await upsertItemTranslation(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      field: 'title',
      value: 'Translated',
      model: 'gemini',
    });
    // A running row without a value yet must be omitted.
    await setTranslationStates(ctx.db, {
      itemType: 'news',
      itemId: hex(2),
      language: 'en',
      fields: ['title'],
      state: 'running',
    });

    const titles = await getTitleTranslations(
      ctx.db,
      'news',
      [hex(1), hex(2), hex(3)],
      'en',
    );
    expect(titles.get(hex(1))).toBe('Translated');
    expect(titles.size).toBe(1);
  });
});
