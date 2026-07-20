import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  findArticlesContainingSourcePage,
  findImagesContainingSourcePage,
} from './queries';
import { imageSources } from './schema/image-sources';
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

  it('ignores articles where neither title nor body contains the term', async () => {
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

  it('matches a term in title_ja even when the body is unfetched (NULL)', async () => {
    // The ArticleWorkflow re-translates the title too, so a title-only match
    // must be re-triggered — including a not-yet-fetched article.
    await ctx.db.insert(topics).values({
      id: TOPIC_ID,
      titleJa: `${TERM}の攻略`,
      publishedAt: AT,
      blocksJa: null,
    });

    expect(
      await findArticlesContainingSourcePage(ctx.db, TERM, 'topic', null, 100),
    ).toEqual([TOPIC_ID]);
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

describe('findImagesContainingSourcePage', () => {
  const imageWith = (key: string, textsJa: string[] | null) =>
    ctx.db.insert(imageSources).values({ key, textsJa, updatedAt: AT });

  it('matches only images whose transcribed spans contain the term', async () => {
    await imageWith('host/hit.png', [`${TERM}の看板`, 'その他']);
    await imageWith('host/miss.png', ['無関係な文字']);
    await imageWith('host/untranscribed.png', null); // instr(NULL) is NULL → excluded
    await imageWith('host/empty.png', []); // "[]" can't contain the term

    const rows = await findImagesContainingSourcePage(ctx.db, TERM, null, 100);
    expect(rows).toEqual([{ id: 1, textsJa: [`${TERM}の看板`, 'その他'] }]);
  });

  it('keyset-paginates through every affected image without dropping any', async () => {
    // 5 matching images; ids autoincrement 1…5. Paging in batches of 2 with the
    // last id as the cursor must return every id exactly once, in id order.
    for (let i = 0; i < 5; i++) {
      await imageWith(`host/img${i}.png`, [`${TERM}${i}`]);
    }

    const collected: number[] = [];
    let cursor: number | null = null;
    for (;;) {
      const page = await findImagesContainingSourcePage(
        ctx.db,
        TERM,
        cursor,
        2,
      );
      if (page.length === 0) break;
      collected.push(...page.map((r) => r.id));
      cursor = page[page.length - 1].id;
      if (page.length < 2) break;
    }

    expect(collected).toEqual([1, 2, 3, 4, 5]);
  });
});
