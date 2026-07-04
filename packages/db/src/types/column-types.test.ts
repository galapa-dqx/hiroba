/**
 * Round-trip tests for the custom Drizzle column types (`instant`,
 * `zonedDateTime`, `json`) through the real schema tables. These serialize on
 * the way in and deserialize on the way out; a silent format change here would
 * corrupt every timestamp and block tree in the database.
 */

import { eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Block } from '@hiroba/richtext';

import { events } from '../schema/events';
import { newsItems } from '../schema/news-items';
import { topics } from '../schema/topics';
import { createTestDb, type TestDb } from '../test-db';

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

describe('instant column', () => {
  it('round-trips a Temporal.Instant at millisecond precision', async () => {
    const publishedAt = Temporal.Instant.from('2026-03-14T09:26:53.123Z');

    await ctx.db.insert(newsItems).values({
      id: 'a'.repeat(32),
      titleJa: 'テスト',
      category: 'news',
      publishedAt,
    });

    const row = await ctx.db
      .select()
      .from(newsItems)
      .where(eq(newsItems.id, 'a'.repeat(32)))
      .get();

    expect(row?.publishedAt).toBeInstanceOf(Temporal.Instant);
    expect(row?.publishedAt.epochMilliseconds).toBe(publishedAt.epochMilliseconds);
    expect(row?.publishedAt.equals(publishedAt)).toBe(true);
  });

  it('round-trips NULL for a nullable instant column', async () => {
    await ctx.db.insert(newsItems).values({
      id: 'b'.repeat(32),
      titleJa: 'テスト',
      category: 'news',
      publishedAt: Temporal.Instant.from('2026-03-14T00:00:00Z'),
      // bodyFetchedAt omitted -> NULL
    });

    const row = await ctx.db
      .select()
      .from(newsItems)
      .where(eq(newsItems.id, 'b'.repeat(32)))
      .get();

    expect(row?.bodyFetchedAt).toBeNull();
  });
});

describe('zonedDateTime column', () => {
  it('round-trips wall-clock time and time zone (offset ignored)', async () => {
    const startTime = Temporal.ZonedDateTime.from(
      '2026-01-15T10:30:00+09:00[Asia/Tokyo]',
    );
    const endTime = Temporal.ZonedDateTime.from(
      '2026-01-15T18:00:00+09:00[Asia/Tokyo]',
    );

    await ctx.db.insert(events).values({
      id: 'evt-span',
      type: 'span',
      titleJa: 'イベント',
      startTime,
      endTime,
      createdAt: Temporal.Instant.from('2026-01-01T00:00:00Z'),
    });

    const row = await ctx.db
      .select()
      .from(events)
      .where(eq(events.id, 'evt-span'))
      .get();

    expect(row?.startTime).toBeInstanceOf(Temporal.ZonedDateTime);
    expect(row?.startTime.equals(startTime)).toBe(true);
    expect(row?.endTime?.equals(endTime)).toBe(true);
    expect(row?.startTime.timeZoneId).toBe('Asia/Tokyo');
  });

  it('round-trips NULL for a nullable zonedDateTime column', async () => {
    await ctx.db.insert(events).values({
      id: 'evt-mark',
      type: 'mark',
      titleJa: 'マイルストーン',
      startTime: Temporal.ZonedDateTime.from('2026-01-15T10:30:00[Asia/Tokyo]'),
      // endTime omitted -> NULL (required for type 'mark')
      createdAt: Temporal.Instant.from('2026-01-01T00:00:00Z'),
    });

    const row = await ctx.db
      .select()
      .from(events)
      .where(eq(events.id, 'evt-mark'))
      .get();

    expect(row?.endTime).toBeNull();
  });
});

describe('json column', () => {
  const blocks: Block[] = [
    { type: 'paragraph', children: [{ type: 'text', text: 'こんにちは' }] },
  ] as unknown as Block[];

  it('round-trips a structured value', async () => {
    await ctx.db.insert(topics).values({
      id: 'c'.repeat(32),
      titleJa: 'トピック',
      publishedAt: Temporal.Instant.from('2026-03-14T00:00:00Z'),
      blocksJa: blocks,
    });

    const row = await ctx.db
      .select()
      .from(topics)
      .where(eq(topics.id, 'c'.repeat(32)))
      .get();

    expect(row?.blocksJa).toEqual(blocks);
  });

  it('round-trips NULL as null (not the string "null")', async () => {
    await ctx.db.insert(topics).values({
      id: 'd'.repeat(32),
      titleJa: 'トピック',
      publishedAt: Temporal.Instant.from('2026-03-14T00:00:00Z'),
      // blocksJa omitted -> NULL
    });

    const row = await ctx.db
      .select()
      .from(topics)
      .where(eq(topics.id, 'd'.repeat(32)))
      .get();

    expect(row?.blocksJa).toBeNull();
  });
});
