import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  banners,
  insertImageRender,
  topics,
  upsertImageTranscription,
  upsertImageTranslation,
} from '@hiroba/db';
import { createTestDb, type TestDb } from '@hiroba/db/test-db';

import { backfillArticleImages, listImagesForAdmin } from './image-queries';

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

describe('backfillArticleImages', () => {
  const SRC_A = 'https://cache.hiroba.dqx.jp/dq_resource/img/a.png';
  const KEY_A = 'cache.hiroba.dqx.jp/dq_resource/img/a.png';

  /** Read the reverse index directly — the shape the purge fan-out consumes. */
  const articlesFor = (key: string) =>
    ctx.db.query.articleImages.findMany({
      columns: { itemType: true, itemId: true },
      where: { imageKey: key },
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
});
