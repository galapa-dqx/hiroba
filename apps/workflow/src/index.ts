/**
 * Workflow worker for the article processing pipeline (news + topics).
 *
 * Contains:
 * - FlowHub DO: the flow framework's control plane (every pipeline runs on it
 *   since DQX-25 — triggers go through hub.start)
 * - Plain domain routes (DQX-26): the per-item SSE progress streams, the
 *   admin tracker's enriched run listing, and synchronous single-image
 *   regeneration
 * - The FlowEntrypoint workflow shells (ArticleWorkflow, PlayguideWorkflow, …)
 * - Cron handlers: hourly news + topics refresh, daily glossary refresh
 */

import * as Sentry from '@sentry/cloudflare';
import { sql } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import {
  createDb,
  getEnabledLanguages,
  getTranslatedItemIds,
  glossary,
  materializeResetEvents,
  pruneResetEvents,
  pruneScheduleEvents,
  reconcileEvents,
  replaceScheduleEvents,
  upsertListItems,
  upsertPlayguideListItems,
  upsertTopicListItems,
  type Database,
  type ListItem,
} from '@hiroba/db';
import { getFlowHub } from '@hiroba/flow/hub';
import { BannerFlow, TitleFlow } from '@hiroba/flows';
import { imageKey, imageUpstreamUrl, type Block } from '@hiroba/richtext';
import {
  crawlPlayguides,
  fetchGlossary,
  fetchTsuyosaForecast,
  scrapeNewsList,
  scrapeTopicsList,
} from '@hiroba/scraper';
import { CATEGORIES } from '@hiroba/shared';

import { domainSSE } from './domain-sse';
import { listFlowRuns } from './flow-runs';
import { flowStart } from './item-flows';
import { createLogger, type Logger } from './logger';
import { processRechecks } from './recheck';
import { regenerateImage } from './regenerate-image';
import { createEventAdjudicator } from './steps/adjudicate-events';
import { buildScheduleEvents } from './steps/build-schedule-events';
import { mirrorImages } from './steps/mirror-images';
import { transcribeImages } from './steps/transcribe-images';
import { translateImageTexts } from './steps/translate-image-texts';
import { translateTitleChunk } from './steps/translate-titles';
import type { Env, ItemType } from './types';

// Export the Durable Object and Workflow classes
export { FlowHub } from './flow-hub';
export { ArticleWorkflow } from './article-workflow';
export { TitleWorkflow } from './title-workflow';
export { TitleBackfillWorkflow } from './title-backfill-workflow';
export { NewsBackfillWorkflow } from './news-backfill-workflow';
export { BannerWorkflow } from './banner-workflow';
export { GlossaryRegenerateWorkflow } from './glossary-regenerate-workflow';
export { PlayguideWorkflow } from './playguide-workflow';

/**
 * Minimum gap between page-driven pipeline re-triggers for one article. A
 * settled-but-degraded article (e.g. an image the model can't produce) is not
 * `complete`, so every organic view would otherwise start a fresh pipeline —
 * full LLM/image work scaling with traffic. Throttling to one attempt per
 * window caps re-run cost at the size of the catalogue, not the traffic to it.
 * Genuine self-healing still happens (just not on every hit); admin, cron, and
 * the watching SSE stream bypass this with `force`. Enforced by the hub
 * (`cooldownMs`); the web app mirrors the value in its own trigger path.
 * (Not exported: workerd treats every entry-module export as a potential
 * entrypoint and refuses to start over a bare const.)
 */
const RETRIGGER_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA.id,
    tracesSampleRate: 1.0,
  }),
  {
    /**
     * Handle HTTP requests. Internal-only (workers_dev = false) — admin/web
     * reach these routes over their WORKFLOW service binding.
     */
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);

      // Health check
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' });
      }

      // The admin tracker's listing: hub runs (with segment snapshots)
      // enriched with per-item domain detail for the article/playguide flows.
      if (url.pathname === '/flow/runs') {
        return listFlowRuns(env, url);
      }

      // SSE stream for one run (?runId=… or ?flow=…&key=…) — the hub's fetch
      // handler owns the protocol; pass the query through untouched.
      if (url.pathname === '/flow/sse') {
        return getFlowHub(env).fetch(request.url);
      }

      // Domain SSE stream: pipeline snapshots for one (item, language) pair,
      // computed from D1 and self-healing via hub.start (DQX-26).
      if (url.pathname === '/sse') {
        return domainSSE(env, url);
      }

      // Synchronous single-image regeneration for the admin edit page — this
      // worker holds the OpenAI key and Images binding the admin lacks.
      if (url.pathname === '/regenerate-image' && request.method === 'POST') {
        return regenerateImage(env, request);
      }

      if (url.pathname === '/flow/start' && request.method === 'POST') {
        const body = (await request.json()) as {
          flow?: string;
          params?: unknown;
          cooldownMs?: number;
          force?: boolean;
        };
        if (!body.flow) {
          return Response.json({ error: 'flow required' }, { status: 400 });
        }
        const result = await getFlowHub(env).start(
          body.flow,
          body.params ?? null,
          { cooldownMs: body.cooldownMs, force: body.force },
        );
        return Response.json(result);
      }

      // Trigger workflow for a specific item (news by default, or topics/playguides)
      if (url.pathname === '/trigger' && request.method === 'POST') {
        const body = (await request.json()) as {
          itemId: string;
          itemType?: ItemType;
          force?: boolean;
        };
        const { itemId } = body;
        const itemType = body.itemType ?? 'news';

        if (!itemId) {
          return Response.json({ error: 'itemId required' }, { status: 400 });
        }

        createLogger(env, 'http').debug(
          `trigger received: ${itemType} ${itemId}`,
        );

        // Every pipeline runs on the flow framework (DQX-24/25): start via
        // the hub, which dedupes on the flow key (playguide = slug, article =
        // `${itemType}:${itemId}`) — a run already in flight is attached to,
        // never doubled. The caller's `force` bypasses the page-view
        // re-trigger cooldown, and `probe` verifies a stale-looking active
        // run against the engine before attaching.
        const start = flowStart(itemType, itemId);
        const result = await getFlowHub(env).start(start.flow, start.params, {
          force: body.force ?? false,
          cooldownMs: RETRIGGER_COOLDOWN_MS,
          probe: true,
        });
        return Response.json(
          result.throttled
            ? { status: 'throttled' }
            : { status: 'started', instanceId: result.runId },
        );
      }

      // Run the event reconcile sweep on demand (the nightly cron runs it too).
      // Used after a bulk re-extract to merge any parallel-extraction races.
      if (url.pathname === '/reconcile' && request.method === 'POST') {
        const db = createDb(env.DB);
        const result = await reconcileEvents(db, {
          adjudicate: createEventAdjudicator(env.GEMINI_API_KEY),
        });
        return Response.json(result);
      }

      return Response.json(
        {
          error: 'Not found',
          endpoints: [
            '/health',
            '/trigger',
            '/reconcile',
            '/sse',
            '/regenerate-image',
            '/flow/start',
            '/flow/runs',
            '/flow/sse',
          ],
        },
        { status: 404 },
      );
    },

    /**
     * Handle scheduled cron jobs.
     *
     * The nightly work is split across staggered triggers so each job gets its
     * own invocation — its own subrequest/CPU budget, and isolation from the
     * others' failures (the playguide crawl alone fetches ~130 pages).
     *
     * Triggers:
     * - "0 * * * *" = Hourly refresh: news + topics list discovery, then the
     *   recheck queue (poll due articles for post-publication edits)
     * - "0 15 * * *" = Daily (midnight JST): glossary + playguide crawl
     * - "10 15 * * *" = Daily: つよさ予報 schedule refresh + reset-milestone
     *   materialize, both with retention prune
     * - "20 15 * * *" = Daily: event reconcile sweep
     */
    async scheduled(
      controller: ScheduledController,
      env: Env,
      _ctx: ExecutionContext,
    ): Promise<void> {
      const db = createDb(env.DB);
      const log = createLogger(env, 'cron');

      log.info(`cron fired: ${controller.cron}`);

      switch (controller.cron) {
        case '0 15 * * *':
          await refreshGlossary(db, log);
          await refreshPlayguides(db, env, log);
          break;
        case '10 15 * * *':
          await refreshSchedule(db, env, log);
          await pruneOldScheduleEvents(db, log);
          await refreshResetEvents(db, log);
          await pruneOldResetEvents(db, log);
          break;
        case '20 15 * * *':
          await reconcileExtractedEvents(db, env, log);
          break;
        default:
          await refreshNews(db, env, log);
          await refreshTopics(db, env, log);
          await refreshBanners(env, log);
          await processRechecks(db, env, log);
      }
    },
  },
);

/**
 * Kick off the BannerFlow to re-scrape and (re-)localize the home-page
 * rotation banners. Idempotent — already-localized banners are skipped — so an
 * hourly run only does real work when the rotation changes. Started via the
 * hub, which dedupes on the flow's constant key: a run still in flight is
 * attached to, never doubled. Best-effort: a failure to enqueue is logged,
 * never fails the refresh.
 */
async function refreshBanners(env: Env, log: Logger): Promise<void> {
  try {
    const result = await getFlowHub(env).start(BannerFlow.name, {});
    if (result.throttled) return; // unreachable without cooldownMs
    log.info(
      result.created
        ? `Enqueued banner refresh (${result.runId})`
        : `Banner refresh already running (${result.runId})`,
    );
  } catch (error) {
    log.error('Failed to enqueue banner refresh:', error);
  }
}

/**
 * Nightly reconcile of extracted calendar events — folds duplicates that
 * creation-time dedup couldn't catch (two articles extracted in parallel, or a
 * title that drifted between re-runs) onto one canonical row. The Gemini judge
 * adjudicates cross-cluster near-misses. Best-effort: a failure is logged, never
 * fails the cron.
 */
async function reconcileExtractedEvents(
  db: Database,
  env: Env,
  log: Logger,
): Promise<void> {
  try {
    const { merged, adjudicated, accepted } = await reconcileEvents(db, {
      adjudicate: createEventAdjudicator(env.GEMINI_API_KEY),
    });
    log.info(
      `Reconciled events (${merged} merged; judge matched ${accepted}/${adjudicated} residuals)`,
    );
  } catch (error) {
    log.error('Failed to reconcile events:', error);
  }
}

/**
 * Re-scrape the つよさ予報 rotation schedules and replace the materialized
 * `events` rows. Deterministic (no LLM/Workflow) — parse straight to rows.
 * Best-effort: a scrape/parse failure is logged, never fails the cron.
 */
async function refreshSchedule(
  db: Database,
  env: Env,
  log: Logger,
): Promise<void> {
  let forecast;
  let rows;
  try {
    forecast = await fetchTsuyosaForecast();
    rows = buildScheduleEvents(forecast, Temporal.Now.instant());
    await replaceScheduleEvents(db, rows);
    log.info(`Refreshed schedule events (${rows.length} rows)`);
  } catch (error) {
    log.error('Failed to refresh schedule events:', error);
    return;
  }

  const languages = await getEnabledLanguages(db);

  // Enrich the icon-only sections: the 防衛軍 brigade banners and 深淵 boss
  // portraits carry the name as baked-in text, so mirror + transcribe (Gemini
  // vision) + translate them through the shared image pipeline. The calendar
  // reads the resulting name back per image key. Idempotent (only new icons
  // cost anything) and best-effort — a failure never fails the cron.
  try {
    const keys = new Set<string>();
    for (const s of [...forecast.defense, ...forecast.abyss]) {
      const key = imageKey(s.iconUrl);
      if (key) keys.add(key);
    }
    if (keys.size > 0) {
      const blocks: Block[] = [...keys].map((key) => ({
        type: 'image',
        src: imageUpstreamUrl(key),
      }));
      await mirrorImages(db, env.IMAGES_BUCKET, blocks);
      await transcribeImages(db, blocks, env.GEMINI_API_KEY, env.IMAGES_BUCKET);
      await translateImageTexts(db, env.GEMINI_API_KEY, blocks, languages);
      log.info(`Transcribed/translated ${keys.size} schedule icons`);
    }
  } catch (error) {
    log.error('Failed to enrich schedule icons:', error);
  }

  // Translate the schedule event titles into each enabled language. This is the
  // "lesser" title translator: it only fills gaps and NEVER overwrites, because
  // article-pipeline event-title translations are authoritative. Schedule events
  // aren't article-bound, so this is their only translation source. Best-effort.
  try {
    const TITLE_BATCH = 50;
    const ids = rows.map((r) => r.id);
    for (const language of languages) {
      if (language.code === 'ja') continue; // source language, nothing to do
      const done = await getTranslatedItemIds(db, 'event', ids, language.code);
      const todo = rows
        .filter((r) => !done.has(r.id))
        .map((r) => ({ id: r.id, titleJa: r.titleJa }));
      for (let i = 0; i < todo.length; i += TITLE_BATCH) {
        await translateTitleChunk(
          db,
          env.GEMINI_API_KEY,
          'event',
          language.code,
          todo.slice(i, i + TITLE_BATCH),
        );
      }
    }
    log.info('Translated schedule event titles');
  } catch (error) {
    log.error('Failed to translate schedule titles:', error);
  }
}

/** How long a scraped schedule occurrence stays around after it has ended. */
const SCHEDULE_RETENTION_MONTHS = 3;

/**
 * Drop schedule events that ended more than the retention horizon ago — they
 * accrete daily (24–48 rows/day for the dense rotations) and only the recent
 * past is interesting as history. Best-effort: a failure is logged, never
 * fails the cron.
 */
async function pruneOldScheduleEvents(
  db: Database,
  log: Logger,
): Promise<void> {
  try {
    const cutoff = Temporal.Now.zonedDateTimeISO('Asia/Tokyo').subtract({
      months: SCHEDULE_RETENTION_MONTHS,
    });
    const pruned = await pruneScheduleEvents(db, cutoff);
    log.info(
      `Pruned ${pruned} schedule events older than ${cutoff.toPlainDate().toString()}`,
    );
  } catch (error) {
    log.error('Failed to prune schedule events:', error);
  }
}

/**
 * Re-materialize the admin-managed reset milestones (daily/weekly/monthly game
 * resets) into `events` for the forward horizon. Deterministic (RRULE expansion,
 * no LLM/Workflow) — parse straight to rows. Best-effort: a failure is logged,
 * never fails the cron.
 */
async function refreshResetEvents(db: Database, log: Logger): Promise<void> {
  try {
    const { marks } = await materializeResetEvents(db);
    log.info(`Refreshed reset milestones (${marks} marks)`);
  } catch (error) {
    log.error('Failed to refresh reset milestones:', error);
  }
}

/** How long a materialized reset milestone stays around after it has passed. */
const RESET_RETENTION_MONTHS = 1;

/**
 * Drop reset marks older than the retention horizon — one mark accretes per day
 * forever, and only the recent past is worth keeping as calendar history.
 * Best-effort: a failure is logged, never fails the cron.
 */
async function pruneOldResetEvents(db: Database, log: Logger): Promise<void> {
  try {
    const cutoff = Temporal.Now.zonedDateTimeISO('Asia/Tokyo').subtract({
      months: RESET_RETENTION_MONTHS,
    });
    const pruned = await pruneResetEvents(db, cutoff);
    log.info(
      `Pruned ${pruned} reset marks older than ${cutoff.toPlainDate().toString()}`,
    );
  } catch (error) {
    log.error('Failed to prune reset milestones:', error);
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
 * Start the TitleFlow over a run's newly-discovered items — the only
 * processing discovery does. The heavy ArticleWorkflow is lazy: it's triggered
 * on first view (the web/admin detail pages), not here. Started via the hub
 * with the flow's RANDOM key: every batch is its own disjoint id set, so
 * concurrent starts must never attach to each other. Best-effort: a failure to
 * enqueue is logged, never fails the refresh.
 */
async function enqueueTitleTranslation(
  env: Env,
  log: Logger,
  itemType: ItemType,
  items: ReadonlyArray<{ id: string }>,
): Promise<void> {
  if (items.length === 0) return;
  try {
    await getFlowHub(env).start(TitleFlow.name, {
      itemType,
      itemIds: items.map((i) => i.id),
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

  await enqueueTitleTranslation(env, log, 'news', newItems);

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

  await enqueueTitleTranslation(env, log, 'topic', newItems);

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
    await enqueueTitleTranslation(env, log, 'playguide', inserted);
    log.info(
      `Playguides refresh complete: ${crawled.length} crawled, ${inserted.length} new`,
    );
  } catch (error) {
    log.error('Failed to refresh playguides:', error);
  }
}
