/**
 * NewsBackfillFlow integration — the real engine, the real hub DO, the real
 * FlowEntrypoint shell. Page BODIES are mocked through the pool-workers
 * introspector (they'd fetch hiroba.dqx.jp and write D1), so what's under
 * test is what the port changed: the scope key at the hub (`category ??
 * 'all'`, replacing the `scrape:news:<category|all>` WorkflowManager DO-name
 * convention) and the drain pool driving real engine steps to a hub-visible
 * completion.
 *
 * Drain page steps memoize `{ stop }` markers (DRAIN_STOP itself never
 * crosses a step boundary), so the mocks below speak that marker shape.
 * Overrun past the stop page is bounded but not pinned — every plausible
 * page number gets a stop mock so no unmocked body ever runs.
 */

import { env, introspectWorkflow } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { hub, waitFor } from './helpers';

const CATEGORIES = ['news', 'event', 'update', 'maintenance'] as const;

/** Generous overrun headroom — dispatch may probe a few pages past the stop. */
const MAX_MOCKED_PAGE = 10;

/** Mock one category's drain: data pages first, stop markers ever after. */
async function mockCategoryPages(
  m: {
    mockStepResult: (q: { name: string }, result: unknown) => Promise<void>;
  },
  category: (typeof CATEGORIES)[number],
  pages: Array<{ scraped: number; newItems: number }>,
): Promise<void> {
  for (let page = 1; page <= MAX_MOCKED_PAGE; page++) {
    const value = pages[page - 1];
    await m.mockStepResult(
      { name: `${category}/page-${page}` },
      value ? { stop: false, value } : { stop: true },
    );
  }
}

describe('NewsBackfillFlow on the hub', () => {
  it('drains a scoped category to complete with the output at the hub', async () => {
    const introspector = await introspectWorkflow(env.NEWS_BACKFILL_WORKFLOW);
    try {
      await introspector.modifyAll(async (m) => {
        await mockCategoryPages(m, 'event', [
          { scraped: 3, newItems: 2 },
          { scraped: 1, newItems: 1 },
        ]);
      });

      const res = await hub().start('news-backfill', { category: 'event' });
      if (res.throttled) throw new Error('throttled');
      expect(res.created).toBe(true);

      // Frame one: the full segment map, one segment per category.
      const seeded = await hub().getSnapshot({ runId: res.runId });
      expect(seeded?.order).toEqual([...CATEGORIES]);

      const snap = await waitFor(
        () => hub().getSnapshot({ runId: res.runId }),
        (s) => s?.status === 'complete',
      );
      expect(snap?.error).toBeNull();
      // The drained segment settled with its total still indeterminate — a
      // drain never learns a denominator. (No `current` assertion: unit
      // reports fire inside page bodies, which the introspector mocks away;
      // per-page counting is pinned by the inline tier.) Out-of-scope
      // categories store skips, not forever-pending.
      expect(snap?.steps.event).toMatchObject({
        state: 'complete',
        total: null,
      });
      expect(snap?.steps.news.state).toBe('skipped');
      expect(snap?.steps.update.state).toBe('skipped');
      expect(snap?.steps.maintenance.state).toBe('skipped');

      const run = await hub().getRun(res.runId);
      // The dedup identity IS the scope.
      expect(run?.key).toBe('event');
      expect(run?.output).toEqual({ pages: 2, scraped: 4, newItems: 3 });
    } finally {
      await introspector.dispose();
    }
  });

  it('dedupes per scope: same scope attaches, another scope runs beside it', async () => {
    const introspector = await introspectWorkflow(env.NEWS_BACKFILL_WORKFLOW);
    try {
      // The contended scope gets real drain work (several data pages, each a
      // stored engine step with its own hub round-trips) so the first run
      // cannot settle in the gap between the two start() calls — an
      // all-stops run is quick enough to make the attach assertion racy.
      const UPDATE_PAGES = Array.from({ length: 6 }, () => ({
        scraped: 1,
        newItems: 0,
      }));
      await introspector.modifyAll(async (m) => {
        for (const category of CATEGORIES) {
          await mockCategoryPages(
            m,
            category,
            category === 'update' ? UPDATE_PAGES : [],
          );
        }
      });

      const first = await hub().start('news-backfill', {
        category: 'update',
      });
      const attached = await hub().start('news-backfill', {
        category: 'update',
      });
      const all = await hub().start('news-backfill', {});
      if (first.throttled || attached.throttled || all.throttled) {
        throw new Error('throttled');
      }

      // Re-triggering a running scope attaches to the run in flight…
      expect(first.created).toBe(true);
      expect(attached.created).toBe(false);
      expect(attached.runId).toBe(first.runId);
      // …while the whole-archive scope is its own run, side by side.
      expect(all.created).toBe(true);
      expect(all.runId).not.toBe(first.runId);

      const allRun = await waitFor(
        () => hub().getRun(all.runId),
        (run) => run?.status === 'complete',
      );
      expect(allRun?.key).toBe('all');
      // The 'all' run drains the same mocks: update's six data pages, empty
      // archives elsewhere.
      expect(allRun?.output).toEqual({ pages: 6, scraped: 6, newItems: 0 });

      await waitFor(
        () => hub().getRun(first.runId),
        (run) => run?.status === 'complete',
      );

      // The run settled — the same scope now starts fresh.
      const again = await hub().start('news-backfill', {
        category: 'update',
      });
      if (again.throttled) throw new Error('throttled');
      expect(again.created).toBe(true);
      expect(again.runId).not.toBe(first.runId);
      await waitFor(
        () => hub().getRun(again.runId),
        (run) => run?.status === 'complete',
      );
    } finally {
      await introspector.dispose();
    }
  });
});
