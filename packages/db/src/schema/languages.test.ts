import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test-db';
import {
  deleteLanguage,
  getEnabledLanguages,
  getLanguageLabel,
  listLanguages,
  upsertLanguage,
} from './languages';

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

describe('getEnabledLanguages', () => {
  it('falls back to English when the table is empty', async () => {
    expect(await getEnabledLanguages(ctx.db)).toEqual([
      { code: 'en', label: 'English', nativeLabel: 'English' },
    ]);
  });

  it('returns only enabled languages, ordered by code', async () => {
    await upsertLanguage(ctx.db, {
      code: 'fr',
      label: 'French',
      nativeLabel: 'Français',
      enabled: true,
    });
    await upsertLanguage(ctx.db, {
      code: 'de',
      label: 'German',
      nativeLabel: 'Deutsch',
      enabled: false,
    });
    await upsertLanguage(ctx.db, {
      code: 'en',
      label: 'English',
      nativeLabel: 'English',
      enabled: true,
    });

    expect(await getEnabledLanguages(ctx.db)).toEqual([
      { code: 'en', label: 'English', nativeLabel: 'English' },
      { code: 'fr', label: 'French', nativeLabel: 'Français' },
    ]);
  });
});

describe('upsertLanguage / listLanguages / deleteLanguage', () => {
  it('creates, updates, and deletes a language', async () => {
    await upsertLanguage(ctx.db, {
      code: 'fr',
      label: 'French',
      nativeLabel: 'Francais',
      enabled: true,
    });
    // Overwrite fixes the native label and disables it.
    await upsertLanguage(ctx.db, {
      code: 'fr',
      label: 'French',
      nativeLabel: 'Français',
      enabled: false,
    });

    const all = await listLanguages(ctx.db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      code: 'fr',
      nativeLabel: 'Français',
      enabled: false,
    });

    expect(await deleteLanguage(ctx.db, 'fr')).toBe(true);
    expect(await deleteLanguage(ctx.db, 'fr')).toBe(false);
    expect(await listLanguages(ctx.db)).toEqual([]);
  });
});

describe('getLanguageLabel', () => {
  it('resolves a whitelisted label and falls back to the code', async () => {
    await upsertLanguage(ctx.db, {
      code: 'fr',
      label: 'French',
      nativeLabel: 'Français',
      enabled: true,
    });

    expect(await getLanguageLabel(ctx.db, 'fr')).toBe('French');
    expect(await getLanguageLabel(ctx.db, 'pt')).toBe('pt');
    // English resolves without a row (the built-in fallback language).
    expect(await getLanguageLabel(ctx.db, 'en')).toBe('English');
  });
});
