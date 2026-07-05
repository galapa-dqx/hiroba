import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test-db';
import { findMatchingGlossaryEntries, glossary } from './glossary';

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

const UPDATED_AT = Temporal.Instant.from('2026-01-01T00:00:00Z');

async function seed(
  entries: Array<{ source: string; lang: string; translated: string }>,
) {
  await ctx.db.insert(glossary).values(
    entries.map((e) => ({
      sourceText: e.source,
      targetLanguage: e.lang,
      translatedText: e.translated,
      updatedAt: UPDATED_AT,
    })),
  );
}

describe('findMatchingGlossaryEntries', () => {
  it('returns entries whose source text is a substring of the input', async () => {
    await seed([
      { source: 'ドラゴン', lang: 'en', translated: 'Dragon' },
      { source: 'スライム', lang: 'en', translated: 'Slime' },
    ]);

    const matches = await findMatchingGlossaryEntries(
      ctx.db,
      'ドラゴンがあらわれた',
      'en',
    );

    expect(matches).toEqual([
      { sourceText: 'ドラゴン', translatedText: 'Dragon' },
    ]);
  });

  it('matches multiple terms present in the text', async () => {
    await seed([
      { source: 'ドラゴン', lang: 'en', translated: 'Dragon' },
      { source: 'スライム', lang: 'en', translated: 'Slime' },
      { source: 'まほう', lang: 'en', translated: 'Magic' },
    ]);

    const matches = await findMatchingGlossaryEntries(
      ctx.db,
      'ドラゴンとスライム',
      'en',
    );

    const sources = matches.map((m) => m.sourceText).sort();
    expect(sources).toEqual(['スライム', 'ドラゴン']);
  });

  it('returns nothing when no term appears in the text', async () => {
    await seed([{ source: 'ドラゴン', lang: 'en', translated: 'Dragon' }]);

    const matches = await findMatchingGlossaryEntries(
      ctx.db,
      'こんにちは',
      'en',
    );

    expect(matches).toEqual([]);
  });

  it('filters by target language', async () => {
    await seed([
      { source: 'ドラゴン', lang: 'en', translated: 'Dragon' },
      { source: 'ドラゴン', lang: 'fr', translated: 'Dragon (fr)' },
    ]);

    const en = await findMatchingGlossaryEntries(ctx.db, 'ドラゴン', 'en');
    const fr = await findMatchingGlossaryEntries(ctx.db, 'ドラゴン', 'fr');

    expect(en).toEqual([{ sourceText: 'ドラゴン', translatedText: 'Dragon' }]);
    expect(fr).toEqual([
      { sourceText: 'ドラゴン', translatedText: 'Dragon (fr)' },
    ]);
  });
});
