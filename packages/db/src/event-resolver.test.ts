import { and, eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  reconcileEvents,
  saveArticleEvents,
  type Adjudicator,
  type ResolvableEvent,
} from './event-resolver';
import { events, eventSources, type EventType } from './schema/events';
import { getEventsForSource } from './schema/events.queries';
import { newsItems } from './schema/news-items';
import { topics } from './schema/topics';
import { translations } from './schema/translations';
import { createTestDb, type TestDb } from './test-db';

let ctx: TestDb;
// One allocator per test: ids stay sequential (ev1, ev2, …) across the several
// saveArticleEvents calls a test makes, so they never collide. Production uses
// random ids — a per-call reset would collide, which is a test artifact only.
let gen: () => string;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.dispose();
});
beforeEach(async () => {
  await ctx.reset();
  gen = idGen();
});

const BASE = Temporal.Instant.from('2026-06-01T00:00:00Z');
const hex = (n: number) => n.toString(16).padStart(32, '0');

/** A ZonedDateTime in JST from a date (`2026-06-25`) or datetime string. */
const z = (s: string): Temporal.ZonedDateTime =>
  s.includes('T')
    ? Temporal.PlainDateTime.from(s).toZonedDateTime('Asia/Tokyo')
    : Temporal.PlainDate.from(s).toZonedDateTime('Asia/Tokyo');

function mev(
  title: string,
  start: string,
  end: string | null = null,
  type: EventType = 'span',
): ResolvableEvent {
  return {
    type,
    titleJa: title,
    startTime: z(start),
    endTime: end ? z(end) : null,
  };
}

/** Insert a news article; `hoursOld` orders publication (smaller = older). */
async function news(
  id: string,
  title: string,
  hoursOld: number,
): Promise<void> {
  await ctx.db.insert(newsItems).values({
    id,
    titleJa: title,
    category: 'news',
    publishedAt: BASE.add({ hours: hoursOld }),
  });
}
async function topic(
  id: string,
  title: string,
  hoursOld: number,
): Promise<void> {
  await ctx.db.insert(topics).values({
    id,
    titleJa: title,
    publishedAt: BASE.add({ hours: hoursOld }),
  });
}

/** Deterministic id allocator so assertions can name minted events. */
function idGen(): () => string {
  let n = 0;
  return () => `ev${++n}`;
}

const allEvents = () => ctx.db.select().from(events).all();
const linksOf = (eventId: string) =>
  ctx.db
    .select()
    .from(eventSources)
    .where(eq(eventSources.eventId, eventId))
    .all();

describe('saveArticleEvents — creation & links', () => {
  it('mints one event + one link per extracted event on a fresh source', async () => {
    await news(hex(1), '記事1', 0);
    const res = await saveArticleEvents(
      ctx.db,
      'news',
      hex(1),
      [mev('キャンペーンA', '2026-06-25', '2026-07-10', 'multiDay')],
      { allocateId: gen },
    );

    expect(res).toMatchObject({ created: 1, matched: 0 });
    expect(res.eventIds).toEqual(['ev1']);
    expect(await allEvents()).toHaveLength(1);
    expect(await linksOf('ev1')).toHaveLength(1);
  });

  it('collapses intra-article duplicates to one event', async () => {
    await news(hex(1), '記事1', 0);
    const res = await saveArticleEvents(
      ctx.db,
      'news',
      hex(1),
      [
        mev('福の神まつり', '2026-06-25', '2026-07-10', 'multiDay'),
        mev('福の神まつり', '2026-06-25', '2026-07-10', 'multiDay'),
      ],
      { allocateId: gen },
    );

    expect(res.eventIds).toEqual(['ev1', 'ev1']); // both indices → same id
    expect(await allEvents()).toHaveLength(1);
  });
});

describe('cross-source dedup', () => {
  it('links two articles to one event when title + start match', async () => {
    await news(hex(1), 'バージョン8.0情報まとめ', 0);
    await topic(
      hex(2),
      'ウェルカムギフト バージョン8こんにちはキャンペーン',
      10,
    );

    const e = mev(
      'ウェルカムギフト バージョン8こんにちはキャンペーン',
      '2026-06-25',
      '2026-08-14',
      'multiDay',
    );
    await saveArticleEvents(ctx.db, 'news', hex(1), [e], {
      allocateId: gen,
    });
    const res2 = await saveArticleEvents(ctx.db, 'topic', hex(2), [e], {
      allocateId: gen,
    });

    expect(res2).toMatchObject({ created: 0, matched: 1 });
    expect(await allEvents()).toHaveLength(1);
    expect((await linksOf('ev1')).map((l) => l.sourceType).sort()).toEqual([
      'news',
      'topic',
    ]);
  });

  it('primary = the source whose headline names the event, not the older roundup', async () => {
    // Roundup published FIRST (oldest) but its headline is generic.
    await news(
      hex(1),
      'バージョン8.0アップデートからのイベント／キャンペーン情報まとめ',
      0,
    );
    await topic(
      hex(2),
      'ウェルカムギフト バージョン8こんにちはキャンペーン',
      240,
    );

    const e = mev(
      'ウェルカムギフト バージョン8こんにちはキャンペーン',
      '2026-06-25',
      '2026-08-14',
      'multiDay',
    );
    await saveArticleEvents(ctx.db, 'news', hex(1), [e], {
      allocateId: gen,
    });
    await saveArticleEvents(ctx.db, 'topic', hex(2), [e], {
      allocateId: gen,
    });

    const [row] = await allEvents();
    expect(row.sourceType).toBe('topic'); // dedicated page wins over roundup
    expect(row.sourceId).toBe(hex(2));
  });

  it('breaks a headline-match tie by oldest publication', async () => {
    await news(hex(1), 'ゼルメアフィーバースタート！', 50);
    await topic(
      hex(2),
      '防具を手に入れるなら今がチャンス！「ゼルメアフィーバー」開催！',
      20,
    );

    const e = mev('ゼルメアフィーバー', '2026-07-09T06:00', '2026-07-18T05:59');
    await saveArticleEvents(ctx.db, 'news', hex(1), [e], {
      allocateId: gen,
    });
    await saveArticleEvents(ctx.db, 'topic', hex(2), [e], {
      allocateId: gen,
    });

    const [row] = await allEvents();
    // Both headlines name it; topic is older (20h < 50h) → topic wins.
    expect(row.sourceId).toBe(hex(2));
  });
});

describe('adjudication of residual candidates', () => {
  it('keeps storefront variants separate when the judge says "not same"', async () => {
    await news(hex(1), 'スタートダッシュセール（Amazon）', 0);
    await topic(hex(2), 'スタートダッシュセール（e-STORE）', 5);

    await saveArticleEvents(
      ctx.db,
      'news',
      hex(1),
      [
        mev(
          'スタートダッシュセール（Amazon／楽天）',
          '2026-06-25',
          '2026-07-12',
          'multiDay',
        ),
      ],
      { allocateId: gen },
    );
    // Same start, different title → residual → judge returns null (distinct).
    const noMatch: Adjudicator = async (r) => r.map(() => null);
    const res = await saveArticleEvents(
      ctx.db,
      'topic',
      hex(2),
      [
        mev(
          'スタートダッシュセール（e-STORE）',
          '2026-06-25',
          '2026-07-23',
          'multiDay',
        ),
      ],
      { allocateId: gen, adjudicate: noMatch },
    );

    expect(res).toMatchObject({ created: 1, matched: 0 });
    expect(await allEvents()).toHaveLength(2);
  });

  it('merges a paraphrase when the judge points at the candidate', async () => {
    await news(hex(1), '記事1', 0);
    await topic(hex(2), '記事2', 5);
    await saveArticleEvents(
      ctx.db,
      'news',
      hex(1),
      [
        mev(
          '第10回 大富豪決定戦 －ゼネシア杯－',
          '2026-07-09T12:00',
          '2026-07-26T23:59',
        ),
      ],
      { allocateId: gen },
    );
    // Judge maps the paraphrase onto the one existing candidate.
    const merge: Adjudicator = async (r) =>
      r.map((res) => res.candidates[0].id);
    const res = await saveArticleEvents(
      ctx.db,
      'topic',
      hex(2),
      [
        mev(
          '第10回 大富豪決定戦（ゼネシア杯）',
          '2026-07-09T12:00',
          '2026-07-26T23:59',
        ),
      ],
      { allocateId: gen, adjudicate: merge },
    );

    expect(res).toMatchObject({ created: 0, matched: 1 });
    expect(await allEvents()).toHaveLength(1);
    expect(await linksOf('ev1')).toHaveLength(2);
  });

  it('ignores a judge verdict that names a non-candidate id', async () => {
    await news(hex(1), '記事1', 0);
    await topic(hex(2), '記事2', 5);
    await saveArticleEvents(
      ctx.db,
      'news',
      hex(1),
      [mev('セールX', '2026-06-25', '2026-07-12', 'multiDay')],
      { allocateId: gen },
    );
    const bogus: Adjudicator = async () => ['not-a-real-id'];
    const res = await saveArticleEvents(
      ctx.db,
      'topic',
      hex(2),
      [mev('セールY', '2026-06-25', '2026-07-20', 'multiDay')],
      { allocateId: gen, adjudicate: bogus },
    );
    expect(res).toMatchObject({ created: 1, matched: 0 }); // fell back to new
    expect(await allEvents()).toHaveLength(2);
  });
});

describe('end-anchored blocking (drifted starts)', () => {
  it('merges an extension notice whose start drifted but deadline matches', async () => {
    // The e-STORE sale (Jun 25 – Jul 23) vs the maintenance notice that extends
    // it: the notice's event starts at its own posting, 12 days later — far past
    // the start tolerance — but carries the identical deadline.
    await news(hex(1), 'スタートダッシュセール開催！', 0);
    await news(hex(2), 'e-STOREにおけるシステムメンテナンスについて', 200);
    await saveArticleEvents(
      ctx.db,
      'news',
      hex(1),
      [
        mev(
          'スタートダッシュセール（e-STORE Windows版）',
          '2026-06-25T00:00',
          '2026-07-23T23:59',
        ),
      ],
      { allocateId: gen },
    );
    const merge: Adjudicator = async (r) =>
      r.map((res) => res.candidates[0].id);
    const res = await saveArticleEvents(
      ctx.db,
      'news',
      hex(2),
      [
        mev(
          'e-STORE「スタートダッシュセール」',
          '2026-07-07T15:30',
          '2026-07-23T23:59',
        ),
      ],
      { allocateId: gen, adjudicate: merge },
    );

    expect(res).toMatchObject({ created: 0, matched: 1 });
    expect(await allEvents()).toHaveLength(1);
    expect(await linksOf('ev1')).toHaveLength(2);
  });

  it('merges a deadline-anchored handout restated with its real window', async () => {
    // A deadline-only mention anchors its start at publication (Jul 3); the
    // テンの日 article states the real window (Jul 10 –). Same deadline, 7 days
    // of start drift.
    await topic(hex(1), '毎月10日はDQXで遊ぼう！', 0);
    await news(hex(2), '7月10日はテンの日！', 100);
    await saveArticleEvents(
      ctx.db,
      'topic',
      hex(1),
      [
        mev(
          '「福の神メダル 3個」プレゼント',
          '2026-07-03T00:00',
          '2026-07-13T05:59',
        ),
      ],
      { allocateId: gen },
    );
    const merge: Adjudicator = async (r) =>
      r.map((res) => res.candidates[0].id);
    const res = await saveArticleEvents(
      ctx.db,
      'news',
      hex(2),
      [
        mev(
          '「福の神メダル×3」受け取り',
          '2026-07-10T06:00',
          '2026-07-13T05:59',
        ),
      ],
      { allocateId: gen, adjudicate: merge },
    );

    expect(res).toMatchObject({ created: 0, matched: 1 });
    expect(await allEvents()).toHaveLength(1);
  });

  it('never consults the judge when neither anchor is close', async () => {
    await news(hex(1), '記事1', 0);
    await news(hex(2), '記事2', 5);
    await saveArticleEvents(
      ctx.db,
      'news',
      hex(1),
      [mev('イベントA', '2026-06-25T00:00', '2026-07-01T00:00')],
      { allocateId: gen },
    );
    const explode: Adjudicator = async () => {
      throw new Error('judge must not run without candidates');
    };
    const res = await saveArticleEvents(
      ctx.db,
      'news',
      hex(2),
      [mev('イベントB', '2026-07-05T00:00', '2026-07-10T00:00')],
      { allocateId: gen, adjudicate: explode },
    );

    expect(res).toMatchObject({ created: 1, matched: 0 });
    expect(await allEvents()).toHaveLength(2);
  });
});

describe('re-extraction: date refresh on match', () => {
  it('lets the primary owner extend an event, but not a non-primary mention', async () => {
    await news(hex(1), 'ゼルメアフィーバー開催！', 0); // primary (headline names it)
    await topic(hex(2), 'バージョン8.0情報まとめ', 5); // roundup (non-primary)
    const orig = mev(
      'ゼルメアフィーバー',
      '2026-07-09',
      '2026-07-18',
      'multiDay',
    );
    await saveArticleEvents(ctx.db, 'news', hex(1), [orig], {
      allocateId: gen,
    });
    await saveArticleEvents(ctx.db, 'topic', hex(2), [orig], {
      allocateId: gen,
    });

    // Roundup re-extracts with a wrong/stale end → must NOT move the schedule.
    await saveArticleEvents(
      ctx.db,
      'topic',
      hex(2),
      [mev('ゼルメアフィーバー', '2026-07-09', '2026-07-30', 'multiDay')],
      { allocateId: gen },
    );
    expect((await allEvents())[0].endTime?.toPlainDate().toString()).toBe(
      '2026-07-18',
    );

    // Primary owner re-extracts with an extended end → schedule updates.
    await saveArticleEvents(
      ctx.db,
      'news',
      hex(1),
      [mev('ゼルメアフィーバー', '2026-07-09', '2026-07-25', 'multiDay')],
      { allocateId: gen },
    );
    expect((await allEvents())[0].endTime?.toPlainDate().toString()).toBe(
      '2026-07-25',
    );
  });
});

describe('re-extraction: stale links & orphan GC', () => {
  it('drops an event that a re-extract no longer yields (sole source)', async () => {
    await news(hex(1), '記事1', 0);
    await saveArticleEvents(
      ctx.db,
      'news',
      hex(1),
      [
        mev('イベントX', '2026-06-25', '2026-07-10', 'multiDay'),
        mev('イベントY', '2026-06-26', '2026-07-11', 'multiDay'),
      ],
      { allocateId: gen },
    );
    // Y gets a title translation; it must be swept with the event.
    await ctx.db.insert(translations).values({
      itemType: 'event',
      itemId: 'ev2',
      language: 'en',
      field: 'title',
      value: 'Event Y',
      state: 'done',
      translatedAt: BASE,
      model: 'test',
      updatedAt: BASE,
    });

    // Re-extract: only X survives.
    await saveArticleEvents(
      ctx.db,
      'news',
      hex(1),
      [mev('イベントX', '2026-06-25', '2026-07-10', 'multiDay')],
      { allocateId: gen },
    );

    const rows = await allEvents();
    expect(rows.map((r) => r.id)).toEqual(['ev1']);
    const orphanTrans = await ctx.db
      .select()
      .from(translations)
      .where(
        and(eq(translations.itemType, 'event'), eq(translations.itemId, 'ev2')),
      )
      .all();
    expect(orphanTrans).toHaveLength(0);
  });

  it('keeps a shared event alive when one source stops mentioning it', async () => {
    await news(hex(1), '記事1', 0);
    await topic(hex(2), '記事2', 5);
    const e = mev('共有イベント', '2026-06-25', '2026-07-10', 'multiDay');
    await saveArticleEvents(ctx.db, 'news', hex(1), [e], {
      allocateId: gen,
    });
    await saveArticleEvents(ctx.db, 'topic', hex(2), [e], {
      allocateId: gen,
    });
    expect(await allEvents()).toHaveLength(1);

    // News drops it; topic still mentions it → event survives with one link.
    await saveArticleEvents(ctx.db, 'news', hex(1), [], {
      allocateId: gen,
    });

    expect(await allEvents()).toHaveLength(1);
    const links = await linksOf('ev1');
    expect(links).toHaveLength(1);
    expect(links[0].sourceType).toBe('topic');
  });
});

describe('getEventsForSource via provenance join', () => {
  it("lists an event on a mentioning article even when it isn't the primary", async () => {
    await news(hex(1), 'バージョン8.0情報まとめ', 0); // roundup (not primary)
    await topic(hex(2), '大富豪決定戦', 10); // dedicated (primary)
    const e = mev('大富豪決定戦', '2026-07-09T12:00', '2026-07-26T23:59');
    await saveArticleEvents(ctx.db, 'news', hex(1), [e], {
      allocateId: gen,
    });
    await saveArticleEvents(ctx.db, 'topic', hex(2), [e], {
      allocateId: gen,
    });

    const onRoundup = await getEventsForSource(ctx.db, 'news', hex(1));
    expect(onRoundup.map((r) => r.id)).toEqual(['ev1']); // still shown on roundup
  });
});

describe('reconcileEvents (nightly sweep)', () => {
  it('folds a parallel-race duplicate into the oldest survivor with both links', async () => {
    await news(hex(1), 'ゼルメアフィーバースタート！', 50);
    await topic(
      hex(2),
      '防具を手に入れるなら今がチャンス！「ゼルメアフィーバー」開催！',
      20,
    );
    // The race: two rows for one campaign, neither having seen the other.
    await ctx.db.insert(events).values([
      {
        id: 'e-old',
        type: 'span',
        titleJa: 'ゼルメアフィーバー',
        startTime: z('2026-07-09T06:00'),
        endTime: z('2026-07-18T05:59'),
        sourceType: 'news',
        sourceId: hex(1),
        createdAt: BASE,
      },
      {
        id: 'e-new',
        type: 'span',
        titleJa: 'ゼルメアフィーバー',
        startTime: z('2026-07-09T06:00'),
        endTime: z('2026-07-18T05:59'),
        sourceType: 'topic',
        sourceId: hex(2),
        createdAt: BASE.add({ hours: 1 }),
      },
    ]);
    await ctx.db.insert(eventSources).values([
      {
        eventId: 'e-old',
        sourceType: 'news',
        sourceId: hex(1),
        createdAt: BASE,
      },
      {
        eventId: 'e-new',
        sourceType: 'topic',
        sourceId: hex(2),
        createdAt: BASE,
      },
    ]);

    const res = await reconcileEvents(ctx.db);

    expect(res.merged).toBe(1);
    const rows = await allEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('e-old'); // oldest createdAt survives
    expect((await linksOf('e-old')).map((l) => l.sourceType).sort()).toEqual([
      'news',
      'topic',
    ]);
    // Primary recomputed across the merged link set: both name it, topic older.
    expect(rows[0].sourceId).toBe(hex(2));
  });

  it('folds same-title rows whose starts drifted but ends match', async () => {
    await news(hex(1), '記事1', 0);
    await topic(hex(2), '記事2', 5);
    await ctx.db.insert(events).values([
      {
        id: 'e-early',
        type: 'span',
        titleJa: '福の神メダルプレゼント',
        startTime: z('2026-07-03T00:00'),
        endTime: z('2026-07-13T05:59'),
        sourceType: 'topic',
        sourceId: hex(2),
        createdAt: BASE,
      },
      {
        id: 'e-late',
        type: 'span',
        titleJa: '福の神メダルプレゼント',
        startTime: z('2026-07-10T06:00'),
        endTime: z('2026-07-13T05:59'),
        sourceType: 'news',
        sourceId: hex(1),
        createdAt: BASE.add({ hours: 1 }),
      },
    ]);
    await ctx.db.insert(eventSources).values([
      {
        eventId: 'e-early',
        sourceType: 'topic',
        sourceId: hex(2),
        createdAt: BASE,
      },
      {
        eventId: 'e-late',
        sourceType: 'news',
        sourceId: hex(1),
        createdAt: BASE,
      },
    ]);

    // Starts are 7 days apart — tier 1 unions on the matching deadline alone.
    const res = await reconcileEvents(ctx.db);

    expect(res.merged).toBe(1);
    const rows = await allEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('e-early');
  });

  it('leaves genuinely distinct same-day events untouched', async () => {
    await news(hex(1), '記事1', 0);
    await ctx.db.insert(events).values([
      {
        id: 'a',
        type: 'multiDay',
        titleJa: 'キャンペーンA',
        startTime: z('2026-06-25'),
        endTime: z('2026-07-10'),
        sourceType: 'news',
        sourceId: hex(1),
        createdAt: BASE,
      },
      {
        id: 'b',
        type: 'multiDay',
        titleJa: 'キャンペーンB',
        startTime: z('2026-06-25'),
        endTime: z('2026-07-10'),
        sourceType: 'news',
        sourceId: hex(1),
        createdAt: BASE,
      },
    ]);
    await ctx.db.insert(eventSources).values([
      { eventId: 'a', sourceType: 'news', sourceId: hex(1), createdAt: BASE },
      { eventId: 'b', sourceType: 'news', sourceId: hex(1), createdAt: BASE },
    ]);

    const res = await reconcileEvents(ctx.db);
    expect(res.merged).toBe(0);
    expect(await allEvents()).toHaveLength(2);
  });
});
