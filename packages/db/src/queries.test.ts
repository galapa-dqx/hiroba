import { and, eq, inArray } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type Database } from './client';
import {
  backfillArticleImages,
  ensureImageSourceRows,
  failPipelineStates,
  getEventsForDay,
  getImageSourcesByKeys,
  getItemTitles,
  getRecheckQueue,
  getServedImages,
  getStats,
  getTitleTranslations,
  insertImageRender,
  listImagesForAdmin,
  resetRunningTitles,
  resetRunningTitlesForLanguage,
  restructureImageTexts,
  saveChangedBody,
  setBodyChecked,
  setImageTranscribeState,
  setTranslationStates,
  updateNewsBlocks,
  updatePlayguideBlocks,
  updateTopicBlocks,
  upsertImageTranscription,
  upsertImageTranslation,
  upsertItemTranslation,
  upsertListItems,
  upsertTopic,
} from './queries';
import { withLocalizedTitle } from './relations';
import { banners } from './schema/banners';
import { events, type NewEvent } from './schema/events';
import { imageSources } from './schema/image-sources';
import { newsItems, type ListItem } from './schema/news-items';
import { topics } from './schema/topics';
import {
  translations,
  type ItemType,
  type Translation,
  type TranslationField,
} from './schema/translations';
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

/**
 * Read back translation states for an item, reporting missing rows as
 * `pending`. Production code no longer needs this shape (DQX-50 deleted the
 * `getTranslationStates` query), but the pipeline-state tests still assert on
 * it, so it lives here as a local helper.
 */
async function readStates(
  db: Database,
  itemType: ItemType,
  itemId: string,
  language: string,
  fields: TranslationField[],
): Promise<Map<TranslationField, Translation['state']>> {
  if (fields.length === 0) return new Map();
  const rows = await db
    .select({ field: translations.field, state: translations.state })
    .from(translations)
    .where(
      and(
        eq(translations.itemType, itemType),
        eq(translations.itemId, itemId),
        eq(translations.language, language),
        inArray(translations.field, fields),
      ),
    )
    .all();
  const byField = new Map(rows.map((r) => [r.field, r.state]));
  return new Map(fields.map((f) => [f, byField.get(f) ?? 'pending']));
}

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

    await resetRunningTitles(ctx.db, 'news', [hex(1), hex(2)]);

    const running = await readStates(ctx.db, 'news', hex(1), 'en', ['title']);
    expect(running.get('title')).toBe('pending');
    const done = await readStates(ctx.db, 'news', hex(2), 'en', ['title']);
    expect(done.get('title')).toBe('done'); // not clobbered
  });

  it('sweeps every language, including ones since disabled', async () => {
    // A run can die after a whitelist edit — the cleanup must not depend on
    // the CURRENT enabled set, so it clears running rows in any language.
    for (const language of ['en', 'ko']) {
      await setTranslationStates(ctx.db, {
        itemType: 'news',
        itemId: hex(1),
        language,
        fields: ['title'],
        state: 'running',
      });
    }

    await resetRunningTitles(ctx.db, 'news', [hex(1)]);

    for (const language of ['en', 'ko']) {
      const states = await readStates(ctx.db, 'news', hex(1), language, [
        'title',
      ]);
      expect(states.get('title')).toBe('pending');
    }
  });

  it('does not touch the content field', async () => {
    await setTranslationStates(ctx.db, {
      itemType: 'news',
      itemId: hex(1),
      language: 'en',
      fields: ['content'],
      state: 'running',
    });
    await resetRunningTitles(ctx.db, 'news', [hex(1)]);
    const states = await readStates(ctx.db, 'news', hex(1), 'en', ['content']);
    expect(states.get('content')).toBe('running');
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

    const news = await readStates(ctx.db, 'news', hex(1), 'en', [
      'title',
      'content',
    ]);
    expect(news.get('title')).toBe('pending');
    expect(news.get('content')).toBe('running'); // not a title
    const topic = await readStates(ctx.db, 'topic', hex(2), 'en', ['title']);
    expect(topic.get('title')).toBe('pending');
    const fr = await readStates(ctx.db, 'news', hex(3), 'fr', ['title']);
    expect(fr.get('title')).toBe('running'); // other language untouched
    const done = await readStates(ctx.db, 'news', hex(4), 'en', ['title']);
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
  it('creates translation rows on first touch and reports missing rows as pending', async () => {
    const states = await readStates(ctx.db, 'topic', hex(1), 'en', [
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
    const running = await readStates(ctx.db, 'topic', hex(1), 'en', [
      'title',
      'content',
    ]);
    expect(running.get('title')).toBe('running');
    expect(running.get('content')).toBe('running');
  });

  it('keeps the previous value when a re-translation flips state to running', async () => {
    await upsertItemTranslation(ctx.db, {
      itemType: 'topic',
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

    await upsertItemTranslation(ctx.db, {
      itemType: 'topic',
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

  it('failPipelineStates settles in-flight translations, not done ones', async () => {
    await upsertListItems(ctx.db, [listItem(1, 1)]);
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

    const states = await readStates(ctx.db, 'news', hex(1), 'en', [
      'title',
      'content',
    ]);
    expect(states.get('title')).toBe('failed');
    expect(states.get('content')).toBe('done');
  });

  it('tracks image discovery and transcription state', async () => {
    await ensureImageSourceRows(ctx.db, ['host/a.png', 'host/b.png']);
    // Idempotent — a second discovery pass must not reset anything.
    await setImageTranscribeState(ctx.db, 'host/a.png', 'running');
    await ensureImageSourceRows(ctx.db, ['host/a.png']);

    let rows = await ctx.db.select().from(imageSources).all();
    expect(rows.map((r) => r.transcribeState).sort()).toEqual([
      'pending',
      'running',
    ]);

    await upsertImageTranscription(ctx.db, {
      key: 'host/a.png',
      textsJa: ['テキスト'],
      model: 'gemini',
    });
    rows = await ctx.db.select().from(imageSources).all();
    const a = rows.find((r) => r.key === 'host/a.png');
    expect(a?.transcribeState).toBe('done');
    expect(a?.textsJa).toEqual(['テキスト']);
  });
});

describe('restructureImageTexts', () => {
  /** An image with three JA spans, translated into en and fr. */
  async function seed() {
    const id = await upsertImageTranscription(ctx.db, {
      key: 'host/spans.png',
      textsJa: ['一', '二', '三'],
      model: 'gpt-vision',
    });
    await upsertImageTranslation(ctx.db, {
      imageId: id,
      language: 'en',
      value: JSON.stringify(['one', 'two', 'three']),
      model: 'gpt-4',
    });
    await upsertImageTranslation(ctx.db, {
      imageId: id,
      language: 'fr',
      value: JSON.stringify(['un', 'deux', 'trois']),
      model: 'gpt-4',
    });
    return id;
  }

  const textsFor = async (id: number, language: string) => {
    const row = await ctx.db
      .select()
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'image'),
          eq(translations.itemId, String(id)),
          eq(translations.language, language),
          eq(translations.field, 'text'),
        ),
      )
      .get();
    return JSON.parse(row!.value!) as string[];
  };

  const jaFor = async (id: number) =>
    (
      await ctx.db
        .select()
        .from(imageSources)
        .where(eq(imageSources.id, id))
        .get()
    )?.textsJa;

  it('drops a middle span from every language at once', async () => {
    const id = await seed();

    // Remove span index 1 ('二'), keeping 0 and 2.
    await restructureImageTexts(ctx.db, id, [
      { text: '一', from: 0 },
      { text: '三', from: 2 },
    ]);

    expect(await jaFor(id)).toEqual(['一', '三']);
    // The survivors must follow their OWN source text, not slide up an index.
    expect(await textsFor(id, 'en')).toEqual(['one', 'three']);
    expect(await textsFor(id, 'fr')).toEqual(['un', 'trois']);
  });

  it('starts an added span blank in every language', async () => {
    const id = await seed();

    await restructureImageTexts(ctx.db, id, [
      { text: '一', from: 0 },
      { text: '二', from: 1 },
      { text: '三', from: 2 },
      { text: '四', from: null },
    ]);

    expect(await jaFor(id)).toEqual(['一', '二', '三', '四']);
    expect(await textsFor(id, 'en')).toEqual(['one', 'two', 'three', '']);
    expect(await textsFor(id, 'fr')).toEqual(['un', 'deux', 'trois', '']);
  });

  it('carries translations through an edited JA span and a reorder', async () => {
    const id = await seed();

    // Fix a typo in span 2's source and move it to the front: the translation
    // belongs to the row, and the row is identified by `from`.
    await restructureImageTexts(ctx.db, id, [
      { text: '参', from: 2 },
      { text: '一', from: 0 },
      { text: '二', from: 1 },
    ]);

    expect(await jaFor(id)).toEqual(['参', '一', '二']);
    expect(await textsFor(id, 'en')).toEqual(['three', 'one', 'two']);
  });

  it('realigns a language whose saved spans ran short', async () => {
    const id = await seed();
    // A partially-translated language: only the first span has text.
    await upsertImageTranslation(ctx.db, {
      imageId: id,
      language: 'de',
      value: JSON.stringify(['eins']),
      model: 'gpt-4',
    });

    await restructureImageTexts(ctx.db, id, [
      { text: '二', from: 1 },
      { text: '一', from: 0 },
    ]);

    // Index 1 was never translated into de → blank, not undefined.
    expect(await textsFor(id, 'de')).toEqual(['', 'eins']);
  });

  it('empties every language when all spans are dropped', async () => {
    const id = await seed();

    await restructureImageTexts(ctx.db, id, []);

    expect(await jaFor(id)).toEqual([]);
    expect(await textsFor(id, 'en')).toEqual([]);
    expect(await textsFor(id, 'fr')).toEqual([]);
  });
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

  it('attaches the text row + localized render for the requested language only', async () => {
    const id = await upsertImageTranscription(ctx.db, {
      key: 'host/localized.png',
      textsJa: ['こんにちは'],
      model: 'gpt-vision',
    });
    await upsertImageTranslation(ctx.db, {
      imageId: id,
      language: 'en',
      value: JSON.stringify(['Hello']),
      model: 'gpt-4',
    });
    const render = (language: string) => ({
      id: crypto.randomUUID(),
      sourceId: id,
      language,
      model: 'gpt-image-2',
      files: [
        {
          key: `l10n/${language}/host/localized.png`,
          isPrimary: true,
          mime: 'image/png' as const,
          width: null,
          height: null,
          bytes: null,
        },
      ],
    });
    await insertImageRender(ctx.db, render('en'));
    // A French render that must not leak into the English view.
    await insertImageRender(ctx.db, render('fr'));

    const en = await listImagesForAdmin(ctx.db, { language: 'en' });
    const row = en.rows.find((r) => r.image.id === id)!;
    expect(row.text?.value).toBe(JSON.stringify(['Hello']));
    expect(row.localized?.key).toBe('l10n/en/host/localized.png');
    expect(row.localized?.model).toBe('gpt-image-2');

    const fr = await listImagesForAdmin(ctx.db, { language: 'fr' });
    const frRow = fr.rows.find((r) => r.image.id === id)!;
    expect(frRow.localized?.key).toBe('l10n/fr/host/localized.png');
    // No French text was translated → no text row yet.
    expect(frRow.text).toBeNull();
  });

  it('tags images that back a rotation banner via isBanner', async () => {
    const bannerId = await upsertImageTranscription(ctx.db, {
      key: 'cache.hiroba.dqx.jp/banner_rotation_20260101_a.png',
      textsJa: [],
      model: 'gpt-vision',
    });
    const plainId = await upsertImageTranscription(ctx.db, {
      key: 'cache.hiroba.dqx.jp/dq_resource/topic-only.png',
      textsJa: [],
      model: 'gpt-vision',
    });
    // Direct insert — syncBanners lives with its flow in apps/workflow now.
    await ctx.db.insert(banners).values({
      imageKey: 'cache.hiroba.dqx.jp/banner_rotation_20260101_a.png',
      altJa: 'バナー',
      sortOrder: 0,
      updatedAt: BASE,
    });

    const { rows } = await listImagesForAdmin(ctx.db, { language: 'en' });
    expect(rows.find((r) => r.image.id === bannerId)?.isBanner).toBe(true);
    expect(rows.find((r) => r.image.id === plainId)?.isBanner).toBe(false);
  });

  it('filters to Japanese-text images server-side with onlyText', async () => {
    const withJa = await upsertImageTranscription(ctx.db, {
      key: 'host/has-ja.png',
      textsJa: ['ぜんぶ', 'ヒーロー'],
      model: 'gpt-vision',
    });
    // Transcribed but no Japanese (roman-only span) — not a localize candidate.
    await upsertImageTranscription(ctx.db, {
      key: 'host/roman-only.png',
      textsJa: ['LEVEL UP'],
      model: 'gpt-vision',
    });
    // Transcribed, empty.
    await upsertImageTranscription(ctx.db, {
      key: 'host/empty.png',
      textsJa: [],
      model: 'gpt-vision',
    });

    const { rows } = await listImagesForAdmin(ctx.db, {
      language: 'en',
      onlyText: true,
    });
    expect(rows.map((r) => r.image.id)).toEqual([withJa]);
  });

  it('filters to banner images server-side with source=banner', async () => {
    const bannerId = await upsertImageTranscription(ctx.db, {
      key: 'cache.hiroba.dqx.jp/rotationbanner/b.png',
      textsJa: ['バナー文'],
      model: 'gpt-vision',
    });
    await upsertImageTranscription(ctx.db, {
      key: 'host/not-a-banner.png',
      textsJa: ['トピック文'],
      model: 'gpt-vision',
    });
    // Direct insert — syncBanners lives with its flow in apps/workflow now.
    await ctx.db.insert(banners).values({
      imageKey: 'cache.hiroba.dqx.jp/rotationbanner/b.png',
      altJa: 'バナー',
      sortOrder: 0,
      updatedAt: BASE,
    });

    const { rows } = await listImagesForAdmin(ctx.db, {
      language: 'en',
      source: 'banner',
    });
    expect(rows.map((r) => r.image.id)).toEqual([bannerId]);
    expect(rows[0].isBanner).toBe(true);
    // onlyText composes with source in the same WHERE clause.
    const both = await listImagesForAdmin(ctx.db, {
      language: 'en',
      source: 'banner',
      onlyText: true,
    });
    expect(both.rows.map((r) => r.image.id)).toEqual([bannerId]);
  });

  it('paginates over the filtered set, not the whole corpus', async () => {
    // Interleave text-bearing and text-free images so a naive page would mix
    // them; the filtered cursor must walk only the text-bearing ones.
    const textIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      textIds.push(
        await upsertImageTranscription(ctx.db, {
          key: `host/ja-${i}.png`,
          textsJa: [`日本語${i}`],
          model: 'gpt-vision',
        }),
      );
      await upsertImageTranscription(ctx.db, {
        key: `host/blank-${i}.png`,
        textsJa: [],
        model: 'gpt-vision',
      });
    }

    const first = await listImagesForAdmin(ctx.db, {
      language: 'en',
      onlyText: true,
      limit: 2,
    });
    expect(first.rows).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await listImagesForAdmin(ctx.db, {
      language: 'en',
      onlyText: true,
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await listImagesForAdmin(ctx.db, {
      language: 'en',
      onlyText: true,
      limit: 2,
      cursor: second.nextCursor,
    });

    // Five text-bearing images total, newest-first, no text-free row leaking in.
    const paged = [...first.rows, ...second.rows, ...third.rows].map(
      (r) => r.image.id,
    );
    expect(paged).toEqual([...textIds].reverse());
    expect(third.hasMore).toBe(false);
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

describe('getEventsForDay day-boundary overlap', () => {
  const zdt = (s: string) => Temporal.ZonedDateTime.from(`${s}:00[Asia/Tokyo]`);

  /** Minimal event row; a null `end` marks a point-in-time event. */
  function ev(id: string, start: string, end: string | null): NewEvent {
    return {
      id,
      type: end ? 'span' : 'mark',
      titleJa: id,
      startTime: zdt(start),
      endTime: end ? zdt(end) : null,
      sourceType: 'schedule',
      sourceId: 'metal',
      createdAt: BASE,
    };
  }

  const idsFor = async (date: string) =>
    (await getEventsForDay(ctx.db, Temporal.PlainDate.from(date)))
      .map((e) => e.id)
      .sort();

  it('assigns an event ending exactly at 00:00 to the previous day, not the next', async () => {
    await ctx.db.insert(events).values([
      // Ends exactly at the July 13 boundary — belongs to July 12 only. The bug:
      // it rendered as a zero-height sliver pinned to the top of July 13.
      ev('ends-at-midnight', '2026-07-12T23:30', '2026-07-13T00:00'),
      // Starts exactly at 00:00 — belongs to July 13 only.
      ev('starts-at-midnight', '2026-07-13T00:00', '2026-07-13T01:00'),
      // Fully inside July 13.
      ev('within-day', '2026-07-13T10:00', '2026-07-13T10:30'),
      // Straddles the boundary — belongs to both days.
      ev('spans-midnight', '2026-07-12T23:00', '2026-07-13T01:00'),
      // Point-in-time event at exactly 00:00 — belongs to July 13.
      ev('point-at-midnight', '2026-07-13T00:00', null),
    ]);

    expect(await idsFor('2026-07-13')).toEqual([
      'point-at-midnight',
      'spans-midnight',
      'starts-at-midnight',
      'within-day',
    ]);
    expect(await idsFor('2026-07-12')).toEqual([
      'ends-at-midnight',
      'spans-midnight',
    ]);
  });
});

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

  it('backfills articles that predate the index', async () => {
    // Simulate a pre-index article: insert the row directly, bypassing the
    // write helpers that would sync.
    await ctx.db.insert(topics).values({
      id: hex(2),
      titleJa: '旧トピック',
      publishedAt: BASE,
      blocksJa: [{ type: 'image', src: SRC_A }],
    });
    expect(await articlesFor(KEY_A)).toEqual([]);

    const result = await backfillArticleImages(ctx.db, 'topic', null, 50);
    expect(result.processed).toBe(1);
    expect(result.nextCursor).toBeNull();
    expect(await articlesFor(KEY_A)).toEqual([
      { itemType: 'topic', itemId: hex(2) },
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
