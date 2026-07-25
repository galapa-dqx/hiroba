import { and, eq, inArray } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type Database } from '../client';
import { upsertListItems } from '../queries';
import { createTestDb, type TestDb } from '../test-db';
import { type ListItem } from './news-items';
import {
  translations,
  type ItemType,
  type Translation,
  type TranslationField,
} from './translations';
import {
  failPipelineStates,
  getTitleTranslations,
  resetRunningTitles,
  resetRunningTitlesForLanguage,
  setTranslationStates,
  upsertItemTranslation,
} from './translations.queries';

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
