import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findArticlesContainingSourcePage } from './queries';
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

describe('findArticlesContainingSourcePage', () => {
  it('matches fetched bodies for the requested type only', async () => {
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

    expect(
      await findArticlesContainingSourcePage(ctx.db, TERM, 'news', null, 100),
    ).toEqual([NEWS_ID]);
    expect(
      await findArticlesContainingSourcePage(ctx.db, TERM, 'topic', null, 100),
    ).toEqual([TOPIC_ID]);
    expect(
      await findArticlesContainingSourcePage(
        ctx.db,
        TERM,
        'playguide',
        null,
        100,
      ),
    ).toEqual(['guide_affected']);
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

    expect(
      await findArticlesContainingSourcePage(ctx.db, TERM, 'news', null, 100),
    ).toEqual([]);
    expect(
      await findArticlesContainingSourcePage(ctx.db, TERM, 'topic', null, 100),
    ).toEqual([]);
  });

  it('keyset-paginates through the entire affected set without dropping any', async () => {
    // 5 matching topics with sortable ids c0…c4. Paging in batches of 2 with the
    // last id as the cursor must return every id exactly once, in id order.
    const ids = Array.from({ length: 5 }, (_, i) => `c${i}`.padEnd(32, '0'));
    for (const id of ids) {
      await ctx.db.insert(topics).values({
        id,
        titleJa: 'トピック',
        publishedAt: AT,
        blocksJa: bodyWith(TERM) as never,
      });
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: string[] = await findArticlesContainingSourcePage(
        ctx.db,
        TERM,
        'topic',
        cursor,
        2,
      );
      if (page.length === 0) break;
      collected.push(...page);
      cursor = page[page.length - 1];
      if (page.length < 2) break;
    }

    // Every id, once, in ascending order — nothing capped away.
    expect(collected).toEqual([...ids].sort());
  });
});
