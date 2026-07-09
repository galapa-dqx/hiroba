/**
 * NewsBackfillWorkflow — whole-archive news list scrape (DQX-14).
 *
 * The admin "Backfill All" once did this inline in the request handler, paging
 * every category's entire archive in one invocation — which blows the Worker
 * subrequest limit (50 on the free plan) and 500s. Here each list page is its
 * own durable `step.do()`, so every page gets a fresh subrequest budget and the
 * whole archive scrapes without a ceiling, with checkpoint/retry for free.
 *
 * Discovery only: each page upserts its list items (title_ja + metadata). Title
 * translation of the freshly-discovered backlog rides the separate
 * TitleBackfillWorkflow (DQX-13); article bodies fetch lazily on first view.
 *
 * Progress is reported best-effort to the owning WorkflowManager DO (named by
 * `streamKey`) after each page, so the admin's SSE stream can show a live bar.
 * The report shares the page step's subrequest budget and is checkpointed with
 * it, so it neither re-runs nor spends subrequests on replay.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import { createDb, upsertListItems } from '@hiroba/db';
import { fetchNewsListPage } from '@hiroba/scraper';
import { CATEGORIES, type Category } from '@hiroba/shared';

import { createLogger, runStep } from './logger';
import type {
  Env,
  NewsBackfillWorkflowOutput,
  NewsBackfillWorkflowParams,
} from './types';

export class NewsBackfillWorkflow extends WorkflowEntrypoint<
  Env,
  NewsBackfillWorkflowParams
> {
  async run(
    event: WorkflowEvent<NewsBackfillWorkflowParams>,
    step: WorkflowStep,
  ): Promise<NewsBackfillWorkflowOutput> {
    const { category, streamKey } = event.payload;
    const categories: readonly Category[] = category ? [category] : CATEGORIES;
    const db = createDb(this.env.DB);
    const log = createLogger(this.env, `news-backfill:${streamKey}`);

    // Push a progress line to the DO that fronts this run's SSE stream.
    // Best-effort: a dropped update just means a slightly stale bar.
    const report = async (
      label: string,
      done: number,
      total: number,
    ): Promise<void> => {
      try {
        const id = this.env.WORKFLOW_MANAGER.idFromName(streamKey);
        await this.env.WORKFLOW_MANAGER.get(id).fetch(
          'http://internal/scrape-progress',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label, done, total }),
          },
        );
      } catch {
        // ignore — progress is cosmetic
      }
    };

    let pages = 0;
    let scraped = 0;
    let newItems = 0;

    for (const cat of categories) {
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages) {
        const soFar = newItems;
        const result = await runStep(step, log, `scrape:${cat}:${page}`, () =>
          scrapePage(db, cat, page, soFar, report),
        );
        totalPages = result.totalPages;
        pages += 1;
        scraped += result.scraped;
        newItems += result.newItems;
        page += 1;
      }
    }

    await report(
      `Done — ${newItems} new item(s) across ${pages} page(s)`,
      pages,
      pages,
    );
    return { pages, scraped, newItems };
  }
}

/**
 * Scrape + upsert one list page, then report progress. Returns the page's
 * counts and the archive's total page count (parsed from the pagination) so the
 * caller knows when to stop. Fetch + report are two subrequests, well under the
 * per-step budget.
 */
async function scrapePage(
  db: ReturnType<typeof createDb>,
  category: Category,
  page: number,
  newSoFar: number,
  report: (label: string, done: number, total: number) => Promise<void>,
): Promise<{ scraped: number; newItems: number; totalPages: number }> {
  const { items, totalPages } = await fetchNewsListPage(category, page);
  const inserted = await upsertListItems(db, items);
  const total = Math.max(totalPages, 1);
  await report(
    `Scraping ${category} — page ${page}/${total} · ${newSoFar + inserted.length} new`,
    page,
    total,
  );
  return {
    scraped: items.length,
    newItems: inserted.length,
    totalPages: total,
  };
}
