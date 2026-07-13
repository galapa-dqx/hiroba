/**
 * The NewsBackfillFlow body — whole-archive news list scrape (DQX-23, the
 * first `drain` flow).
 *
 * Each requested category is one `drain` pool: the pool owns the page counter,
 * every list page is its own durable unit (fresh subrequest budget, so the
 * archive scrapes without a ceiling), and an empty page stops dispatch.
 * Progress is indeterminate the whole way — the archive's true size isn't
 * known up front, so the segment renders as `N…` pages done.
 *
 * Discovery only: each page upserts its list items (title_ja + metadata).
 * Title translation of the freshly-discovered backlog rides the separate
 * TitleBackfillWorkflow (DQX-13); article bodies fetch lazily on first view.
 *
 * This replaces the DQX-14 raw WorkflowEntrypoint: the per-page `report()`
 * POST to the WorkflowManager DO is gone — units report through the tracker
 * and the admin follows the hub's per-run SSE snapshots instead.
 *
 * Platform-free on purpose (no cloudflare:workers import): the FlowEntrypoint
 * shell lives in news-backfill-workflow.ts, and this body runs under
 * runFlowInline in plain-node vitest.
 */

import { createDb, upsertListItems } from '@hiroba/db';
import { DRAIN_STOP, type Flow } from '@hiroba/flow';
import { type NewsBackfillFlow } from '@hiroba/flows';
import { fetchNewsListPage } from '@hiroba/scraper';
import { CATEGORIES, type Category } from '@hiroba/shared';

import type {
  Env,
  NewsBackfillWorkflowOutput,
  NewsBackfillWorkflowParams,
} from './types';

/**
 * Pages in flight per category. Modest on purpose — the archive belongs to
 * someone else's site, and the old workflow paged strictly serially; this
 * merely overlaps a couple of round-trips. Also bounds the harmless overrun
 * past the first empty page.
 */
export const NEWS_BACKFILL_CONCURRENCY = 2;

/** The slice of the worker env the body actually touches. */
export type NewsBackfillFlowEnv = Pick<Env, 'DB'>;

/** One drained page's contribution to the run totals. */
type PageResult = { scraped: number; newItems: number };

export async function runNewsBackfillFlow(
  f: Flow<(typeof NewsBackfillFlow)['steps']>,
  params: NewsBackfillWorkflowParams,
  env: NewsBackfillFlowEnv,
): Promise<NewsBackfillWorkflowOutput> {
  const requested: readonly Category[] = params.category
    ? [params.category]
    : CATEGORIES;
  const db = createDb(env.DB);

  let pages = 0;
  let scraped = 0;
  let newItems = 0;

  for (const cat of CATEGORIES) {
    if (!requested.includes(cat)) {
      f.skip(cat, `scoped to ${params.category}`);
      continue;
    }

    const results = await f.drain<PageResult>(
      cat,
      async (page) => {
        const { items, totalPages } = await fetchNewsListPage(cat, page);
        // Two stop signals: a genuinely empty page, or the pagination saying
        // this page is past the end. The latter matters because the site
        // clamps an out-of-range page to the last real one — without it the
        // overrun pages would re-count (and re-upsert) the final page's items.
        if (page > totalPages || items.length === 0) return DRAIN_STOP;
        const inserted = await upsertListItems(db, items);
        return { scraped: items.length, newItems: inserted.length };
      },
      { concurrency: NEWS_BACKFILL_CONCURRENCY },
    );

    pages += results.length;
    for (const result of results) {
      scraped += result.scraped;
      newItems += result.newItems;
    }
  }

  return { pages, scraped, newItems };
}
