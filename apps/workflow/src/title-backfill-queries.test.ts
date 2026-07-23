import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  setTranslationStates,
  upsertItemTranslation,
  upsertListItems,
  upsertTopic,
  type ListItem,
} from '@hiroba/db';
import { createTestDb, type TestDb } from '@hiroba/db/test-db';

import { getUntranslatedTitles } from './title-backfill-queries';

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
