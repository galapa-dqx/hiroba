import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findArticlesContainingSource } from './queries';
import { newsItems } from './schema/news-items';
import { playguides } from './schema/playguides';
import { topics } from './schema/topics';
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
  // reset() doesn't wipe playguides (not in its table list), so clear it here.
  await ctx.db.delete(playguides);
});

const NEWS_ID = 'a1'.repeat(16);
const NEWS_ID_MISS = 'a2'.repeat(16);
const TOPIC_ID = 'b1'.repeat(16);
const TOPIC_ID_NULL = 'b2'.repeat(16);
const TERM = 'レンドア城'; // Japanese term to search bodies for
const AT = Temporal.Instant.from('2026-01-01T00:00:00Z');

const bodyWith = (text: string) => [{ type: 'paragraph', children: [text] }];

describe('findArticlesContainingSource', () => {
  it('matches fetched bodies across all three article types', async () => {
    await ctx.db.insert(newsItems).values({
      id: NEWS_ID,
      titleJa: 'ニュース',
      category: 'news',
      publishedAt: AT,
      blocksJa: bodyWith(`${TERM}の情報`) as never,
    });
    await ctx.db.insert(topics).values({
      id: TOPIC_ID,
      titleJa: 'トピック',
      publishedAt: AT,
      blocksJa: bodyWith(`ようこそ${TERM}へ`) as never,
    });
    await ctx.db.insert(playguides).values({
      id: 'guide_affected',
      titleJa: 'ガイド',
      sortOrder: 0,
      blocksJa: bodyWith(TERM) as never,
    });

    const { items, hasMore } = await findArticlesContainingSource(ctx.db, TERM);

    expect(hasMore).toBe(false);
    expect(new Set(items)).toEqual(
      new Set([
        { itemType: 'news', id: NEWS_ID },
        { itemType: 'topic', id: TOPIC_ID },
        { itemType: 'playguide', id: 'guide_affected' },
      ]),
    );
  });

  it('ignores bodies without the term and un-fetched (NULL) bodies', async () => {
    await ctx.db.insert(newsItems).values({
      id: NEWS_ID_MISS,
      titleJa: 'ニュース',
      category: 'news',
      publishedAt: AT,
      blocksJa: bodyWith('無関係な本文') as never,
    });
    await ctx.db.insert(topics).values({
      id: TOPIC_ID_NULL,
      titleJa: 'トピック',
      publishedAt: AT,
      blocksJa: null,
    });

    const { items } = await findArticlesContainingSource(ctx.db, TERM);

    expect(items).toEqual([]);
  });

  it('caps results at the limit and flags hasMore', async () => {
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert(topics).values({
        // 32-char hex ids: 'c0…', 'c1…', 'c2…'
        id: `c${i}`.padEnd(32, '0'),
        titleJa: 'トピック',
        publishedAt: AT,
        blocksJa: bodyWith(TERM) as never,
      });
    }

    const { items, hasMore } = await findArticlesContainingSource(
      ctx.db,
      TERM,
      2,
    );

    expect(items).toHaveLength(2);
    expect(hasMore).toBe(true);
  });
});
