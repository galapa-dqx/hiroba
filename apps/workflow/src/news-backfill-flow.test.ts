/**
 * NewsBackfillFlow body on the fast inline tier: the drain pool per category
 * (page-numbers-until-empty with the pool owning the counter), the clamp
 * guard (an out-of-range page is a stop signal, never re-counted work), the
 * category scoping skips, and replay from memo. The real engine + hub (and
 * the scope-keyed dedup) are covered in test/news-backfill-flow.test.ts.
 *
 * Collaborators are module-mocked (not engine-stubbed) so the real unit
 * bodies execute and their lifecycle reports fire.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { upsertListItems, type ListItem } from '@hiroba/db';
import { runFlowInline } from '@hiroba/flow';
import { NewsBackfillFlow } from '@hiroba/flows';
import { fetchNewsListPage } from '@hiroba/scraper';
import type { Category } from '@hiroba/shared';

import {
  runNewsBackfillFlow,
  type NewsBackfillFlowEnv,
} from './news-backfill-flow';

vi.mock('@hiroba/db', () => ({
  createDb: vi.fn(() => ({})),
  upsertListItems: vi.fn(),
}));

vi.mock('@hiroba/scraper', () => ({
  fetchNewsListPage: vi.fn(),
}));

const ENV = { DB: {} } as unknown as NewsBackfillFlowEnv;

/** Only `id` matters to the flow (upsert dedup) — the rest is inert fixture. */
const item = (id: string): ListItem =>
  ({
    id,
    titleJa: `title-${id}`,
    category: 'news',
    publishedAt: 0,
  }) as unknown as ListItem;

/**
 * Archive fixture: item pages per category. `update` is an empty archive —
 * hiroba serves its landing page with no items and totalPages 1.
 */
const ARCHIVE: Record<Category, ListItem[][]> = {
  news: [[item('n1'), item('n2'), item('n3')], [item('n4')]],
  event: [[item('e1'), item('e2')]],
  update: [],
  maintenance: [[item('m1')]],
};

const DATA_PAGES = Object.values(ARCHIVE).flat();
const TOTAL_ITEMS = DATA_PAGES.flat().length;

beforeEach(() => {
  vi.clearAllMocks();
  // Real (post-fix) parser contract, including the hazard the clamp guard
  // exists for: an out-of-range page is CLAMPED to the last real page (same
  // items again), never served empty — only `totalPages` gives the overrun
  // away. extractTotalPages counts the unlinked current-page marker, so the
  // genuine last page reports its own number and only clamped overruns
  // report less than the requested page (pinned by the scraper's own
  // pagination-shape tests against live-captured DOM).
  vi.mocked(fetchNewsListPage).mockImplementation(async (category, page) => {
    const pages = ARCHIVE[category];
    if (pages.length === 0) return { items: [], totalPages: 1 };
    const clamped = Math.min(page, pages.length);
    return { items: pages[clamped - 1], totalPages: pages.length };
  });
  // Every item is new on first sight, a duplicate after — mirrors the
  // ON CONFLICT DO NOTHING ... RETURNING contract.
  const seen = new Set<string>();
  vi.mocked(upsertListItems).mockImplementation(async (_db, items) => {
    const fresh = items.filter((item) => !seen.has(item.id));
    fresh.forEach((item) => seen.add(item.id));
    return fresh as never;
  });
});

describe('news backfill flow — drain per category', () => {
  it('drains every category to the empty/clamped page and totals the run', async () => {
    const result = await runFlowInline(
      NewsBackfillFlow,
      (f, params) => runNewsBackfillFlow(f, params, ENV),
      {},
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({
      pages: DATA_PAGES.length,
      scraped: TOTAL_ITEMS,
      newItems: TOTAL_ITEMS,
    });

    // The clamp guard held: only real pages were upserted, once each — the
    // overrun pages (clamped repeats of the last page) never re-counted.
    expect(vi.mocked(upsertListItems)).toHaveBeenCalledTimes(DATA_PAGES.length);

    // Segment truth: every category settled complete with one unit per DATA
    // page (the stop probe reports no unit), total indeterminate throughout.
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.snapshot.steps.news).toMatchObject({
      state: 'complete',
      current: 2,
      total: null,
    });
    expect(result.snapshot.steps.update).toMatchObject({
      state: 'complete',
      current: 0,
      total: null,
    });
    expect(result.snapshot.steps.maintenance).toMatchObject({
      state: 'complete',
      current: 1,
      total: null,
    });
  });

  it('scopes to one category and stores skips on the rest', async () => {
    const result = await runFlowInline(
      NewsBackfillFlow,
      (f, params) => runNewsBackfillFlow(f, params, ENV),
      { category: 'event' },
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ pages: 1, scraped: 2, newItems: 2 });

    expect(result.snapshot.steps.event.state).toBe('complete');
    for (const key of ['news', 'update', 'maintenance'] as const) {
      expect(result.snapshot.steps[key].state).toBe('skipped');
    }
    // Only the scoped category was ever fetched.
    const categoriesFetched = new Set(
      vi.mocked(fetchNewsListPage).mock.calls.map(([category]) => category),
    );
    expect(categoriesFetched).toEqual(new Set(['event']));
  });

  it('replays from memo: pages answer from unit returns, nothing re-upserts', async () => {
    const first = await runFlowInline(
      NewsBackfillFlow,
      (f, params) => runNewsBackfillFlow(f, params, ENV),
      {},
    );
    expect(first.error).toBeUndefined();

    vi.clearAllMocks();
    const replay = await runFlowInline(
      NewsBackfillFlow,
      (f, params) => runNewsBackfillFlow(f, params, ENV),
      {},
      { memo: first.memo },
    );

    expect(replay.error).toBeUndefined();
    expect(replay.output).toEqual(first.output);
    // Every data page answered from memo — no writes re-ran. (An overrun
    // probe page can dispatch fresh — dispatch order isn't part of the memo —
    // which is harmless by construction, so fetches aren't pinned here.)
    expect(vi.mocked(upsertListItems)).not.toHaveBeenCalled();
  });

  it('a failed page fetch fails that category step and the run', async () => {
    vi.mocked(fetchNewsListPage).mockImplementation(async (category) => {
      if (category === 'maintenance') throw new Error('hiroba 503');
      const pages = ARCHIVE[category];
      if (pages.length === 0) return { items: [], totalPages: 1 };
      return { items: pages[0], totalPages: pages.length };
    });

    const result = await runFlowInline(
      NewsBackfillFlow,
      (f, params) => runNewsBackfillFlow(f, params, ENV),
      {},
    );

    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain('hiroba 503');
    expect(result.snapshot.status).toBe('failed');
    expect(result.snapshot.steps.maintenance.state).toBe('failed');
  });
});
