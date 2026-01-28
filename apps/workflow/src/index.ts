/**
 * Workflow worker for news processing pipeline.
 *
 * Contains:
 * - WorkflowManager DO: WebSocket + workflow coordination
 * - NewsWorkflow: Multi-step processing pipeline
 * - Cron handlers: Hourly news refresh, daily glossary refresh
 */

import * as Sentry from '@sentry/cloudflare';
import { sql } from 'drizzle-orm';

import { createDb, glossary, upsertListItems, type Database } from '@hiroba/db';
import { fetchGlossary, scrapeNewsList } from '@hiroba/scraper';
import { CATEGORIES } from '@hiroba/shared';

import type { Env } from './types';

// Export the Durable Object and Workflow classes
export { WorkflowManager } from './workflow-manager';
export { NewsWorkflow } from './news-workflow';

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

      // Trigger workflow for a specific item
      if (url.pathname === '/trigger' && request.method === 'POST') {
        const body = (await request.json()) as { itemId: string };
        const { itemId } = body;

        if (!itemId) {
          return Response.json({ error: 'itemId required' }, { status: 400 });
        }

        // Route to the DO for this item
        const doId = env.WORKFLOW_MANAGER.idFromName(itemId);
        const stub = env.WORKFLOW_MANAGER.get(doId);

        return stub.fetch('http://internal/trigger', {
          method: 'POST',
          body: JSON.stringify({ itemId }),
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
     * - "0 * * * *" = Hourly news refresh (first page of each category)
     * - "0 15 * * *" = Daily glossary refresh (midnight JST)
     */
    async scheduled(
      controller: ScheduledController,
      env: Env,
      _ctx: ExecutionContext,
    ): Promise<void> {
      const db = createDb(env.DB);

      const isGlossaryRefresh = controller.cron === '0 15 * * *';

      if (isGlossaryRefresh) {
        await refreshGlossary(db);
      } else {
        await refreshNews(db, env);
      }
    },
  },
);

/**
 * Refresh glossary from GitHub CSV.
 */
async function refreshGlossary(db: Database): Promise<void> {
  try {
    const entries = await fetchGlossary();
    const now = Math.floor(Date.now() / 1000);

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

    console.log(`Glossary refresh complete: ${inserted} entries loaded`);
  } catch (error) {
    console.error('Glossary refresh failed:', error);
  }
}

/**
 * Refresh news by scraping first page of each category.
 * Triggers workflow for each new item found.
 */
async function refreshNews(db: Database, env: Env): Promise<void> {
  let totalNew = 0;
  let workflowsTriggered = 0;
  let errors = 0;

  for (const category of CATEGORIES) {
    try {
      // Scrape first page only for scheduled refresh
      for await (const items of scrapeNewsList(category)) {
        const inserted = await upsertListItems(db, items);
        totalNew += inserted.length;

        // Trigger workflow for each new item
        for (const item of inserted) {
          try {
            const doId = env.WORKFLOW_MANAGER.idFromName(item.id);
            const stub = env.WORKFLOW_MANAGER.get(doId);

            await stub.fetch('http://internal/trigger', {
              method: 'POST',
              body: JSON.stringify({ itemId: item.id }),
              headers: { 'Content-Type': 'application/json' },
            });

            workflowsTriggered++;
          } catch (error) {
            console.error(`Failed to trigger workflow for ${item.id}:`, error);
          }
        }

        // Only scrape first page in scheduled job
        break;
      }
    } catch (error) {
      console.error(`Failed to scrape ${category}:`, error);
      errors++;
    }
  }

  console.log(
    `Scheduled refresh complete: ${totalNew} new items, ${workflowsTriggered} workflows triggered, ${errors} errors`,
  );
}
