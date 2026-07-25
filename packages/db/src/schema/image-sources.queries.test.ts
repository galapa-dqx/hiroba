import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test-db';
import { imageSources } from './image-sources';
import {
  ensureImageSourceRows,
  restructureImageTexts,
  setImageTranscribeState,
  upsertImageTranscription,
} from './image-sources.queries';
import { newsItems } from './news-items';
import { translations } from './translations';
import { upsertImageTranslation } from './translations.queries';

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

describe('image source discovery + transcription state', () => {
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
