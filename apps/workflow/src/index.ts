/**
 * Workflow worker for the article processing pipeline (news + topics).
 *
 * Contains:
 * - WorkflowManager DO: SSE + workflow coordination
 * - ArticleWorkflow: unified multi-step processing pipeline
 * - Cron handlers: hourly news + topics refresh, daily glossary refresh
 */

import * as Sentry from '@sentry/cloudflare';
import { sql } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import {
  createDb,
  getEnabledLanguages,
  glossary,
  upsertListItems,
  upsertPlayguideListItems,
  upsertTopicListItems,
  type Database,
  type ListItem,
} from '@hiroba/db';
import {
  crawlPlayguides,
  fetchGlossary,
  scrapeNewsList,
  scrapeTopicsList,
} from '@hiroba/scraper';
import { CATEGORIES } from '@hiroba/shared';

import { createLogger, type Logger } from './logger';
import { processRechecks } from './recheck';
import type { Env, ItemType } from './types';

// Export the Durable Object and Workflow classes
export { WorkflowManager } from './workflow-manager';
export { ArticleWorkflow } from './article-workflow';
export { TitleWorkflow } from './title-workflow';
export { TitleBackfillWorkflow } from './title-backfill-workflow';
export { NewsBackfillWorkflow } from './news-backfill-workflow';
export { BannerWorkflow } from './banner-workflow';

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA.id,
    tracesSampleRate: 1.0,
  }),
  {
    /**
     * Handle HTTP requests.
     * Routes requests to the appropriate WorkflowManager DO.
     */
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);

      // Health check
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' });
      }

      // Route /workflow/* requests to the WorkflowManager DO
      if (url.pathname.startsWith('/workflow/')) {
        const itemId = url.pathname.split('/')[2];
        if (!itemId) {
          return Response.json(
            { error: 'itemId required in path' },
            { status: 400 },
          );
        }

        // Get DO stub for this item
        const doId = env.WORKFLOW_MANAGER.idFromName(itemId);
        const stub = env.WORKFLOW_MANAGER.get(doId);

        // Forward the request to the DO
        const doUrl = new URL(request.url);
        doUrl.pathname = url.pathname.replace(`/workflow/${itemId}`, '');
        if (!doUrl.pathname) doUrl.pathname = '/';

        return stub.fetch(doUrl.toString(), request);
      }

      // Trigger workflow for a specific item (news by default, or topics/playguides)
      if (url.pathname === '/trigger' && request.method === 'POST') {
        const body = (await request.json()) as {
          itemId: string;
          itemType?: ItemType;
        };
        const { itemId } = body;
        const itemType = body.itemType ?? 'news';

        if (!itemId) {
          return Response.json({ error: 'itemId required' }, { status: 400 });
        }

        createLogger(env, 'http').debug(
          `trigger received: ${itemType} ${itemId}`,
        );

        // Route to the DO for this item, namespaced by type so ids don't collide
        // (news = bare id; topic/playguide = `<type>:<id>`).
        const doName = itemType === 'news' ? itemId : `${itemType}:${itemId}`;
        const doId = env.WORKFLOW_MANAGER.idFromName(doName);
        const stub = env.WORKFLOW_MANAGER.get(doId);

        return stub.fetch('http://internal/trigger', {
          method: 'POST',
          body: JSON.stringify({ itemId, itemType }),
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return Response.json(
        {
          error: 'Not found',
          endpoints: ['/health', '/trigger', '/workflow/:itemId/*'],
        },
        { status: 404 },
      );
    },

    /**
     * Handle scheduled cron jobs.
     *
     * Triggers:
     * - "0 * * * *" = Hourly refresh: news + topics list discovery, then the
     *   recheck queue (poll due articles for post-publication edits)
     * - "0 15 * * *" = Daily glossary refresh (midnight JST)
     */
    async scheduled(
      controller: ScheduledController,
      env: Env,
      _ctx: ExecutionContext,
    ): Promise<void> {
      const db = createDb(env.DB);
      const log = createLogger(env, 'cron');

      const isGlossaryRefresh = controller.cron === '0 15 * * *';
      log.info(
        `cron fired: ${controller.cron} (${isGlossaryRefresh ? 'glossary' : 'news+topics'} refresh)`,
      );

      if (isGlossaryRefresh) {
        await refreshGlossary(db, log);
        await refreshPlayguides(db, env, log);
      } else {
        await refreshNews(db, env, log);
        await refreshTopics(db, env, log);
        await refreshBanners(env, log);
        await processRechecks(db, env, log);
      }
    },
  },
);

/**
 * Kick off the BannerWorkflow to re-scrape and (re-)localize the home-page
 * rotation banners. Idempotent — already-localized banners are skipped — so an
 * hourly run only does real work when the rotation changes. Best-effort: a
 * failure to enqueue is logged, never fails the refresh.
 */
async function refreshBanners(env: Env, log: Logger): Promise<void> {
  try {
    const instance = await env.BANNER_WORKFLOW.create({ params: {} });
    log.info(`Enqueued banner refresh (${instance.id})`);
  } catch (error) {
    log.error('Failed to enqueue banner refresh:', error);
  }
}

/**
 * Refresh glossary from GitHub CSV.
 */
async function refreshGlossary(db: Database, log: Logger): Promise<void> {
  try {
    const entries = await fetchGlossary();
    const now = Temporal.Now.instant();

    // Clear existing glossary and insert new entries
    await db.delete(glossary);

    // Insert in batches
    const BATCH_SIZE = 25;
    let inserted = 0;

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);

      await db
        .insert(glossary)
        .values(
          batch.map((e) => ({
            sourceText: e.japanese_text,
            targetLanguage: 'en',
            translatedText: e.english_text,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [glossary.sourceText, glossary.targetLanguage],
          set: {
            translatedText: sql`excluded.translated_text`,
            updatedAt: sql`excluded.updated_at`,
          },
        });

      inserted += batch.length;
    }

    log.info(`Glossary refresh complete: ${inserted} entries loaded`);
  } catch (error) {
    log.error('Glossary refresh failed:', error);
  }
}

/**
 * Enqueue the durable TitleWorkflow for a run's newly-discovered items — the
 * only processing discovery does. The heavy ArticleWorkflow is lazy: it's
 * triggered on first view (the web/admin detail pages), not here. Best-effort:
 * a failure to enqueue is logged, never fails the refresh.
 */
async function enqueueTitleTranslation(
  db: Database,
  env: Env,
  log: Logger,
  itemType: ItemType,
  items: ReadonlyArray<{ id: string }>,
): Promise<void> {
  if (items.length === 0) return;
  try {
    const languages = await getEnabledLanguages(db);
    await env.TITLE_WORKFLOW.create({
      params: {
        itemType,
        itemIds: items.map((i) => i.id),
        languages: languages.map((l) => l.code),
      },
    });
    log.info(
      `Enqueued title translation for ${items.length} new ${itemType} item(s)`,
    );
  } catch (error) {
    log.error(`Failed to enqueue ${itemType} title translation:`, error);
  }
}

/**
 * Refresh news by scraping the first page of each category. Discovery is
 * titles-only: new items are upserted and their titles translated via the
 * TitleWorkflow (DQX-11); the full ArticleWorkflow runs lazily on first view.
 */
async function refreshNews(db: Database, env: Env, log: Logger): Promise<void> {
  let totalNew = 0;
  let errors = 0;
  // Every newly-discovered item this run, whose titles the TitleWorkflow
  // translates so lists read in the target language pre-visit (DQX-11).
  const newItems: ListItem[] = [];

  for (const category of CATEGORIES) {
    try {
      // Scrape first page only for scheduled refresh
      for await (const items of scrapeNewsList(category)) {
        const inserted = await upsertListItems(db, items);
        totalNew += inserted.length;
        newItems.push(...inserted);
        log.debug(
          `News ${category}: ${inserted.length} new of ${items.length} scraped`,
        );

        // Only scrape first page in scheduled job
        break;
      }
    } catch (error) {
      log.error(`Failed to scrape ${category}:`, error);
      errors++;
    }
  }

  await enqueueTitleTranslation(db, env, log, 'news', newItems);

  log.info(
    `Scheduled refresh complete: ${totalNew} new items, ${errors} errors`,
  );
}

/**
 * Refresh topics by scraping the current (not-yet-archived) listing page.
 * Discovery is titles-only (mirrors refreshNews): new topics are upserted and
 * their titles translated via the TitleWorkflow; the full ArticleWorkflow runs
 * lazily on first view.
 *
 * Note: the first run after deploy (empty topics table) treats the whole current
 * month as new — one TitleWorkflow chunks through them; steady state is a couple
 * per day. A full historical backfill is the separate DQX-13 ticket.
 */
async function refreshTopics(
  db: Database,
  env: Env,
  log: Logger,
): Promise<void> {
  let totalNew = 0;
  const newItems: Array<{ id: string; titleJa: string }> = [];

  try {
    for await (const items of scrapeTopicsList({ incremental: true })) {
      const inserted = await upsertTopicListItems(db, items);
      totalNew += inserted.length;
      newItems.push(...inserted);
    }
  } catch (error) {
    log.error('Failed to scrape topics:', error);
  }

  await enqueueTitleTranslation(db, env, log, 'topic', newItems);

  log.info(`Topics refresh complete: ${totalNew} new topics`);
}

/**
 * Refresh playguides by crawling the guide tree from `guide01` (discovery is
 * titles-only, mirroring refreshNews/refreshTopics): newly-discovered pages are
 * upserted and their titles translated via the TitleWorkflow; the full
 * ArticleWorkflow runs lazily on first view. Runs on the daily cron — guides are
 * static reference pages that change rarely, so an hourly crawl would be wasteful.
 *
 * A re-crawl also corrects the sort order / provisional titles of existing rows
 * without clobbering fetched bodies (upsertPlayguideListItems sets metadata only).
 */
async function refreshPlayguides(
  db: Database,
  env: Env,
  log: Logger,
): Promise<void> {
  try {
    const crawled = await crawlPlayguides();
    const inserted = await upsertPlayguideListItems(
      db,
      crawled.map((c) => ({
        id: c.slug,
        titleJa: c.titleJa,
        sortOrder: c.sortOrder,
      })),
    );
    await enqueueTitleTranslation(db, env, log, 'playguide', inserted);
    log.info(
      `Playguides refresh complete: ${crawled.length} crawled, ${inserted.length} new`,
    );
  } catch (error) {
    log.error('Failed to refresh playguides:', error);
  }
}
