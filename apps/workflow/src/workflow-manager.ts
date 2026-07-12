/**
 * WorkflowManager - Durable Object for coordinating workflow operations.
 *
 * Handles both the news and topics pipelines, which share one ArticleWorkflow
 * binding: the trigger payload carries an `itemType` ('news' | 'topic'), passed
 * through as a workflow param (the steps use it to pick the backing table) and
 * used to compute pipeline snapshots. The DO is namespaced per (itemType,
 * itemId) by the caller, so news and topic ids (both 32-char hex) never collide.
 *
 * Responsibilities:
 * - Stream SSE progress updates to connected clients
 * - Create/track workflow instances
 * - Poll workflow status and emit events
 *
 * SSE events carry machine-readable pipeline snapshots (see @hiroba/shared's
 * pipeline-state module) computed from D1, not from the workflow instance's
 * output. D1 is the ground truth: image rows are shared across topics, so
 * progress can be advanced by a different item's workflow — and a client that
 * connects after everything finished still gets a terminal event.
 */

import { DurableObject } from 'cloudflare:workers';
import { Temporal } from 'temporal-polyfill';

import {
  computeImageDetail,
  computeSnapshot,
  createDb,
  getActiveWorkflowRun,
  getEnabledLanguages,
  getNewsItem,
  getPlayguide,
  getTitleTranslations,
  getTopic,
  listWorkflowRuns,
  pruneWorkflowRuns,
  recordWorkflowRun,
  updateWorkflowRunStatus,
} from '@hiroba/db';
import {
  describeSnapshot,
  isRunActive,
  isSnapshotSettled,
  type Category,
  type SSEEvent,
  type StateSnapshot,
  type WorkflowRunEntry,
  type WorkflowRunStatus,
} from '@hiroba/shared';

import type { Env, ItemType, NewsBackfillWorkflowOutput } from './types';

/** How long settled runs stay in the tracker's listing. */
const SETTLED_VISIBLE_HOURS = 24;
/** How long settled rows stay in the registry at all (GC horizon). */
const SETTLED_RETAINED_HOURS = 24 * 7;

type Active = { instanceId: string; itemType: ItemType };

/** The body-bearing item types that flow through the ArticleWorkflow. */
const ARTICLE_ITEM_TYPES = ['news', 'topic', 'playguide'] as const;

/** Parse a wire `itemType` string to an ArticleWorkflow item type (news default). */
function parseItemType(value: string | null | undefined): ItemType {
  return (ARTICLE_ITEM_TYPES as readonly string[]).includes(value ?? '')
    ? (value as ItemType)
    : 'news';
}

/** Topics and playguides carry text-bearing images; news does not. */
const hasImages = (itemType: ItemType): boolean => itemType !== 'news';

export class WorkflowManager extends DurableObject<Env> {
  /** Track active workflow instances by item ID. */
  private activeWorkflows = new Map<string, Active>();
  /**
   * The in-flight title backfill per language (DQX-13). Callers route every
   * backfill trigger for a language to this DO under the well-known
   * `title-backfill:<lang>` instance name, so one instance sees them all and
   * this map is the single dedup point — mirrors activeWorkflows.
   */
  private activeBackfills = new Map<string, string>();
  /**
   * The in-flight whole-archive scrape for this DO instance (DQX-14). A scrape
   * DO is dedicated (named `scrape:news:<category|all>`), so one field suffices:
   * the workflow POSTs `/scrape-progress` here after each page and the
   * `/scrape-sse` stream reads `progress` back. In-memory — a mid-run eviction
   * just resets the bar until the next page's report.
   */
  private scrape: {
    instanceId: string;
    progress: { label: string; done?: number; total?: number };
  } | null = null;
  /**
   * The in-flight rotation-banner refresh (DQX banners). Callers address a
   * dedicated `banners` instance so this field is the single dedup point —
   * mirrors `scrape`.
   */
  private bannerRefresh: string | null = null;
  /**
   * In-flight glossary regenerations, keyed by the changed source term. Callers
   * address a dedicated `glossary-regenerate:<term>` instance so this map is the
   * single dedup point — re-triggering the same term while it runs is a no-op.
   */
  private activeRegenerations = new Map<string, string>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/sse') {
      return this.handleSSE(url);
    }
    if (url.pathname === '/trigger' && request.method === 'POST') {
      return this.handleTrigger(request);
    }
    if (url.pathname === '/status') {
      const itemId = url.searchParams.get('itemId');
      if (!itemId)
        return Response.json({ error: 'itemId required' }, { status: 400 });
      return this.handleStatus(itemId);
    }
    if (url.pathname === '/runs') {
      return this.handleRuns();
    }
    if (url.pathname === '/enqueue-titles' && request.method === 'POST') {
      return this.handleEnqueueTitles(request);
    }
    if (url.pathname === '/backfill-titles' && request.method === 'POST') {
      return this.handleBackfillTitles(request);
    }
    if (url.pathname === '/scrape-news' && request.method === 'POST') {
      return this.handleScrapeNews(request);
    }
    if (url.pathname === '/scrape-progress' && request.method === 'POST') {
      return this.handleScrapeProgress(request);
    }
    if (url.pathname === '/scrape-sse') {
      return this.handleScrapeSSE();
    }
    if (url.pathname === '/refresh-banners' && request.method === 'POST') {
      return this.handleRefreshBanners();
    }
    if (url.pathname === '/regenerate-glossary' && request.method === 'POST') {
      return this.handleRegenerateGlossary(request);
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  /**
   * Handle SSE connection — streams pipeline snapshots for a (item, language)
   * pair as server-sent events, closing with a terminal complete/error event.
   */
  private handleSSE(url: URL): Response {
    const itemId = url.searchParams.get('itemId');
    if (!itemId) {
      return new Response('itemId query param required', { status: 400 });
    }
    const language = url.searchParams.get('language') ?? 'en';

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (event: SSEEvent) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        };

        // Item type: from the active workflow when there is one, else from the
        // caller (the proxy routes know which pipeline they front).
        let active = this.activeWorkflows.get(itemId);
        const itemType: ItemType =
          active?.itemType ?? parseItemType(url.searchParams.get('itemType'));

        const db = createDb(this.env.DB);

        // Emit snapshots only when they change; finish with complete when the
        // article itself made it (failed images degrade, they don't block),
        // error when a prerequisite failed.
        let lastSent: string | null = null;
        const emit = (snapshot: StateSnapshot) => {
          const encoded = JSON.stringify(snapshot);
          if (encoded === lastSent) return;
          lastSent = encoded;
          send({ type: 'state', snapshot });
        };
        const finish = (snapshot: StateSnapshot) => {
          if (snapshot.article === 'done' && snapshot.translation === 'done') {
            send({ type: 'complete' });
          } else {
            send({ type: 'error', error: describeSnapshot(snapshot) });
          }
          this.activeWorkflows.delete(itemId);
          controller.close();
        };

        try {
          // Initial snapshot — a client connecting after the pipeline already
          // settled gets its terminal event immediately.
          let snapshot = await computeSnapshot(db, itemType, itemId, language);
          emit(snapshot);
          if (isSnapshotSettled(snapshot)) {
            finish(snapshot);
            return;
          }

          if (!active) {
            // Unsettled and nothing running here: the item was never processed
            // (the page's fire-and-forget trigger can be dropped), or the DO
            // restarted, or the client reached the stream first. Start the
            // pipeline ourselves rather than erroring — the stream is
            // self-healing, so viewing an unprocessed article kicks it off.
            active = await this.ensureArticleWorkflow(itemId, itemType);
          }

          const workflow = this.env.ARTICLE_WORKFLOW;
          const pollInterval = 1000;
          const maxPolls = 300; // 5 minutes

          for (let i = 0; i < maxPolls; i++) {
            await new Promise((resolve) => setTimeout(resolve, pollInterval));

            snapshot = await computeSnapshot(db, itemType, itemId, language);
            emit(snapshot);
            if (isSnapshotSettled(snapshot)) {
              finish(snapshot);
              return;
            }

            const instance = await workflow.get(active.instanceId);
            const status = await instance.status();
            if (
              status.status === 'complete' ||
              status.status === 'errored' ||
              status.status === 'terminated'
            ) {
              // The workflow is finished; whatever the snapshot says now is
              // all it will ever say (errored workflows settle their states in
              // their mark-failed step before reaching this point).
              snapshot = await computeSnapshot(db, itemType, itemId, language);
              emit(snapshot);
              finish(snapshot);
              return;
            }
          }

          this.activeWorkflows.delete(itemId);
          send({ type: 'error', error: 'Workflow timeout' });
          controller.close();
        } catch (error) {
          console.error('Error streaming workflow status:', error);
          send({ type: 'error', error: 'Polling failed' });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /** Handle workflow trigger request. */
  private async handleTrigger(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      itemId: string;
      itemType?: ItemType;
    };
    const { itemId } = body;
    const itemType: ItemType = body.itemType ?? 'news';

    if (!itemId) {
      return Response.json({ error: 'itemId required' }, { status: 400 });
    }

    const active = await this.ensureArticleWorkflow(itemId, itemType);
    return Response.json({ status: 'started', instanceId: active.instanceId });
  }

  /**
   * The status (and error) the Workflows engine reports for an instance, or
   * null when it can't be resolved. Kept in terms of the engine's own status —
   * not a boolean — so this dedup path agrees with the tracker's reconciler
   * (handleRuns) on what counts as live: `isRunActive` treats `paused` as
   * in-flight too, and a finished run settles to its real terminal status
   * rather than a misleading `unknown`.
   *
   * `get`/`status` throws both for a genuinely-forgotten instance and for a
   * transient engine error, with nothing to tell them apart. We retry a few
   * times so a one-off blip doesn't read as "gone": a null result therefore
   * means the failure *persisted*, which — paired with a `create()` that still
   * succeeds (see ensureArticleWorkflow) — indicates the instance really is
   * gone, not merely briefly unreachable.
   */
  private async getEngineStatus(
    instanceId: string,
    attempts = 3,
  ): Promise<{ status: WorkflowRunStatus; error: string | null } | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const engine = await (
          await this.env.ARTICLE_WORKFLOW.get(instanceId)
        ).status();
        return { status: engine.status, error: engine.error ?? null };
      } catch {
        if (attempt < attempts - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, 200 * (attempt + 1)),
          );
        }
      }
    }
    return null;
  }

  /**
   * Ensure an ArticleWorkflow is running for this item and return the tracked
   * handle. Dedupes so an item never has two in-flight runs at once:
   *
   *  - the whole check-and-create runs inside `blockConcurrencyWhile`, so a
   *    burst of concurrent triggers to this DO (e.g. a page's fire-and-forget
   *    POST /trigger racing its own self-healing SSE stream) is serialized —
   *    the first creates, the rest observe it and reuse;
   *  - it consults the durable `workflow_runs` registry, not just the
   *    in-memory map, so a trigger landing on a freshly-evicted DO (empty map)
   *    still finds an in-flight run instead of starting a duplicate.
   *
   * A finished/forgotten run starts fresh. Recording the new run is
   * best-effort — a registry miss must never fail the trigger. Shared by the
   * `/trigger` endpoint and the self-healing SSE stream.
   */
  private async ensureArticleWorkflow(
    itemId: string,
    itemType: ItemType,
  ): Promise<Active> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const workflow = this.env.ARTICLE_WORKFLOW;
      const db = createDb(this.env.DB);

      // Fast path: a single optimistic probe lets a warm DO confirm its
      // remembered run is still live without a D1 read (and covers a run whose
      // best-effort registry write was lost). Anything ambiguous falls through
      // to the authoritative durable path.
      const existing = this.activeWorkflows.get(itemId);
      if (existing) {
        const engine = await this.getEngineStatus(existing.instanceId, 1);
        if (engine && isRunActive(engine.status)) return existing;
      }

      // Durable path: the registry survives DO eviction, so a trigger on a cold
      // DO still finds an in-flight run. Reuse it while the engine reports it
      // live; otherwise it has finished (a confirmed terminal status) or, after
      // retries, can't be resolved at all — a run that's genuinely gone. Either
      // way we start a replacement below and retire this row as `stale`.
      const registered = await getActiveWorkflowRun(db, itemType, itemId);
      let stale: {
        instanceId: string;
        status: WorkflowRunStatus;
        error: string | null;
      } | null = null;
      if (registered) {
        const engine = await this.getEngineStatus(registered.instanceId);
        if (engine && isRunActive(engine.status)) {
          const active: Active = {
            instanceId: registered.instanceId,
            itemType,
          };
          this.activeWorkflows.set(itemId, active);
          return active;
        }
        stale = {
          instanceId: registered.instanceId,
          status: engine?.status ?? 'unknown',
          error: engine
            ? engine.error
            : 'Instance no longer known to the Workflows engine',
        };
      }

      // Create the replacement FIRST — it doubles as an engine health probe.
      // If the engine is down this throws before we touch the registry, so a
      // `stale` row we couldn't resolve stays active and the item is simply
      // retried (never orphaned, never duplicated by an outage). A create that
      // succeeds proves the engine is healthy, so an unresolvable `stale` row
      // really is gone — not merely unreachable — and superseding it is safe.
      const instance = await workflow.create({ params: { itemId, itemType } });
      const active: Active = { instanceId: instance.id, itemType };
      this.activeWorkflows.set(itemId, active);
      try {
        // Retire the superseded row to its real status BEFORE recording the new
        // one, so the partial unique index (one active row per item) never sees
        // two at once.
        if (stale) {
          await updateWorkflowRunStatus(
            db,
            stale.instanceId,
            stale.status,
            stale.error ?? undefined,
          );
        }
        await recordWorkflowRun(db, {
          instanceId: instance.id,
          itemType,
          itemId,
        });
      } catch (error) {
        console.error('Failed to record workflow run:', error);
      }
      return active;
    });
  }

  /**
   * Enqueue the durable TitleWorkflow for a set of newly-discovered items.
   * Lets the admin's scrape endpoints (which only hold this DO binding) kick
   * off the same eager title translation the hourly cron does. Global state
   * only, so any instance can serve it — callers use the well-known
   * 'registry' instance.
   */
  private async handleEnqueueTitles(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      itemType?: ItemType;
      itemIds?: unknown;
    };
    const itemType: ItemType = parseItemType(body.itemType);
    const itemIds = Array.isArray(body.itemIds)
      ? body.itemIds.filter((id): id is string => typeof id === 'string')
      : [];

    if (itemIds.length === 0) {
      return Response.json({ status: 'empty', enqueued: 0 });
    }

    const languages = await getEnabledLanguages(createDb(this.env.DB));
    const instance = await this.env.TITLE_WORKFLOW.create({
      params: { itemType, itemIds, languages: languages.map((l) => l.code) },
    });
    return Response.json({
      status: 'enqueued',
      enqueued: itemIds.length,
      instanceId: instance.id,
    });
  }

  /**
   * Fire the whole-archive TitleBackfillWorkflow for one language (DQX-13),
   * deduping concurrent runs: if a backfill for this language is already
   * running or queued, the trigger is a no-op. Callers address this DO by the
   * `title-backfill:<lang>` instance name so every trigger for a language lands
   * here and activeBackfills is authoritative.
   *
   * Fire-and-forget from the caller's side (list-view triggers, admin
   * pre-warm), so it stays cheap and idempotent — over-triggering never starts
   * a second run.
   */
  private async handleBackfillTitles(request: Request): Promise<Response> {
    const body = (await request.json()) as { language?: unknown };
    const language = typeof body.language === 'string' ? body.language : '';
    if (!language) {
      return Response.json({ error: 'language required' }, { status: 400 });
    }

    const workflow = this.env.TITLE_BACKFILL_WORKFLOW;
    const existing = this.activeBackfills.get(language);
    if (existing) {
      try {
        const status = await (await workflow.get(existing)).status();
        if (status.status === 'running' || status.status === 'queued') {
          return Response.json({
            status: 'already_running',
            instanceId: existing,
          });
        }
      } catch {
        // The engine no longer knows the instance (evicted/expired) — fall
        // through and start a fresh run.
      }
    }

    const instance = await workflow.create({ params: { language } });
    this.activeBackfills.set(language, instance.id);
    return Response.json({ status: 'started', instanceId: instance.id });
  }

  /**
   * Start (or resume streaming an already-running) whole-archive news scrape
   * (DQX-14). Deduped: if this DO's scrape instance is still queued/running we
   * report it rather than launch a second. `streamKey` names this DO instance so
   * the workflow can POST progress back to `/scrape-progress`.
   */
  private async handleScrapeNews(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      category?: unknown;
      streamKey?: unknown;
    };
    const streamKey = typeof body.streamKey === 'string' ? body.streamKey : '';
    if (!streamKey) {
      return Response.json({ error: 'streamKey required' }, { status: 400 });
    }
    const category =
      typeof body.category === 'string'
        ? (body.category as Category)
        : undefined;

    const workflow = this.env.NEWS_BACKFILL_WORKFLOW;
    if (this.scrape) {
      try {
        const status = await (
          await workflow.get(this.scrape.instanceId)
        ).status();
        if (status.status === 'running' || status.status === 'queued') {
          return Response.json({
            status: 'already_running',
            instanceId: this.scrape.instanceId,
          });
        }
      } catch {
        // The engine no longer knows the instance — fall through and start fresh.
      }
    }

    const instance = await workflow.create({
      params: { category, streamKey },
    });
    this.scrape = {
      instanceId: instance.id,
      progress: { label: 'Starting…' },
    };
    return Response.json({ status: 'started', instanceId: instance.id });
  }

  /** Sink for the scrape workflow's per-page progress reports. */
  private async handleScrapeProgress(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      label?: unknown;
      done?: unknown;
      total?: unknown;
    };
    if (this.scrape) {
      this.scrape.progress = {
        label: typeof body.label === 'string' ? body.label : '',
        done: typeof body.done === 'number' ? body.done : undefined,
        total: typeof body.total === 'number' ? body.total : undefined,
      };
    }
    return Response.json({ ok: true });
  }

  /**
   * Stream the current scrape's progress as SSE `progress` events, closing with
   * `complete`/`error` when the workflow instance settles. Mirrors handleSSE but
   * over the generic progress channel instead of pipeline snapshots.
   */
  private handleScrapeSSE(): Response {
    const encoder = new TextEncoder();
    const scrape = this.scrape;
    const workflow = this.env.NEWS_BACKFILL_WORKFLOW;

    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (event: SSEEvent) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        };

        if (!scrape) {
          send({ type: 'complete', summary: 'No active scrape' });
          controller.close();
          return;
        }

        let lastSent: string | null = null;
        const emit = () => {
          const p = this.scrape?.progress;
          if (!p) return;
          const key = `${p.label}|${p.done}|${p.total}`;
          if (key === lastSent) return;
          lastSent = key;
          send({
            type: 'progress',
            label: p.label,
            done: p.done,
            total: p.total,
          });
        };

        emit();
        const maxPolls = 1800; // 30 minutes at 1s
        for (let i = 0; i < maxPolls; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          emit();
          try {
            const status = await (
              await workflow.get(scrape.instanceId)
            ).status();
            if (status.status === 'complete') {
              const out = status.output as
                | NewsBackfillWorkflowOutput
                | undefined;
              send({
                type: 'complete',
                summary: out
                  ? `${out.newItems} new item(s) across ${out.pages} page(s)`
                  : undefined,
              });
              controller.close();
              return;
            }
            if (status.status === 'errored' || status.status === 'terminated') {
              send({ type: 'error', error: status.error ?? 'Scrape failed' });
              controller.close();
              return;
            }
          } catch {
            // Instance not registered yet, or a transient engine hiccup — the
            // next poll retries.
          }
        }
        send({ type: 'error', error: 'Scrape timeout' });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /**
   * Fire the BannerWorkflow to re-scrape and re-localize the home-page rotation
   * banners, deduping a run that's already queued/running. Fire-and-forget from
   * the admin; the workflow is idempotent so over-triggering is harmless.
   */
  private async handleRefreshBanners(): Promise<Response> {
    const workflow = this.env.BANNER_WORKFLOW;
    if (this.bannerRefresh) {
      try {
        const status = await (await workflow.get(this.bannerRefresh)).status();
        if (status.status === 'running' || status.status === 'queued') {
          return Response.json({
            status: 'already_running',
            instanceId: this.bannerRefresh,
          });
        }
      } catch {
        // The engine no longer knows the instance — fall through, start fresh.
      }
    }
    const instance = await workflow.create({ params: {} });
    this.bannerRefresh = instance.id;
    return Response.json({ status: 'started', instanceId: instance.id });
  }

  /**
   * Fire the GlossaryRegenerateWorkflow for a changed glossary term, deduping a
   * run that's already queued/running for the same term. Callers address this DO
   * by the `glossary-regenerate:<term>` instance name so every trigger for a term
   * lands here and `activeRegenerations` is authoritative. The workflow itself
   * scans D1 for the affected articles, so only the term travels in the payload.
   */
  private async handleRegenerateGlossary(request: Request): Promise<Response> {
    const body = (await request.json()) as { sourceText?: unknown };
    const sourceText =
      typeof body.sourceText === 'string' ? body.sourceText.trim() : '';
    if (!sourceText) {
      return Response.json({ error: 'sourceText required' }, { status: 400 });
    }

    const workflow = this.env.GLOSSARY_REGENERATE_WORKFLOW;
    const existing = this.activeRegenerations.get(sourceText);
    if (existing) {
      try {
        const status = await (await workflow.get(existing)).status();
        if (status.status === 'running' || status.status === 'queued') {
          return Response.json({
            status: 'already_running',
            instanceId: existing,
          });
        }
      } catch {
        // The engine no longer knows the instance — fall through, start fresh.
      }
    }

    const instance = await workflow.create({ params: { sourceText } });
    this.activeRegenerations.set(sourceText, instance.id);
    return Response.json({ status: 'started', instanceId: instance.id });
  }

  /** Handle status request. */
  private async handleStatus(itemId: string): Promise<Response> {
    const active = this.activeWorkflows.get(itemId);
    if (!active) return Response.json({ status: 'idle' });

    try {
      const instance = await this.env.ARTICLE_WORKFLOW.get(active.instanceId);
      const status = await instance.status();
      return Response.json({
        status: status.status,
        instanceId: active.instanceId,
        output: status.output,
        error: status.error,
      });
    } catch {
      this.activeWorkflows.delete(itemId);
      return Response.json({ status: 'idle' });
    }
  }

  /**
   * List recent workflow runs for the admin tracker: every still-active run
   * plus runs settled in the last SETTLED_VISIBLE_HOURS, each reconciled
   * against the Workflows engine and enriched with its D1 pipeline snapshot
   * and per-image detail.
   *
   * Reads only global state (the registry table + engine), so it works from
   * any instance of this DO — callers use a well-known 'registry' instance
   * rather than an item-scoped one.
   */
  private async handleRuns(): Promise<Response> {
    const db = createDb(this.env.DB);
    const now = Temporal.Now.instant();

    await pruneWorkflowRuns(
      db,
      now.subtract({ hours: SETTLED_RETAINED_HOURS }),
    );
    const runs = await listWorkflowRuns(db, {
      settledSince: now.subtract({ hours: SETTLED_VISIBLE_HOURS }),
    });

    // Batch the translated titles per item type (cheap title-row-only reads).
    const titleEn = new Map<string, string>();
    for (const itemType of ARTICLE_ITEM_TYPES) {
      const ids = runs
        .filter((r) => r.itemType === itemType)
        .map((r) => r.itemId);
      const titles = await getTitleTranslations(db, itemType, ids, 'en');
      for (const [id, title] of titles) titleEn.set(`${itemType}:${id}`, title);
    }

    const entries: WorkflowRunEntry[] = [];
    for (const run of runs) {
      let status: WorkflowRunStatus = run.status;
      let error = run.error;
      let updatedAt = run.updatedAt;
      if (isRunActive(status)) {
        try {
          const instance = await this.env.ARTICLE_WORKFLOW.get(run.instanceId);
          const engine = await instance.status();
          if (engine.status !== status || (engine.error ?? null) !== error) {
            status = engine.status;
            error = engine.error ?? null;
            updatedAt = now;
            await updateWorkflowRunStatus(
              db,
              run.instanceId,
              status,
              error ?? undefined,
            );
          }
        } catch {
          // The engine no longer knows this instance (evicted/expired) —
          // settle it as unknown so we stop polling it.
          status = 'unknown';
          error = 'Instance no longer known to the Workflows engine';
          updatedAt = now;
          await updateWorkflowRunStatus(db, run.instanceId, status, error);
        }
      }

      const item =
        run.itemType === 'topic'
          ? await getTopic(db, run.itemId)
          : run.itemType === 'playguide'
            ? await getPlayguide(db, run.itemId)
            : await getNewsItem(db, run.itemId);
      const snapshot = await computeSnapshot(
        db,
        run.itemType,
        run.itemId,
        'en',
      );
      const images =
        hasImages(run.itemType) && item
          ? await computeImageDetail(db, item.blocksJa, 'en')
          : [];

      entries.push({
        instanceId: run.instanceId,
        itemType: run.itemType,
        itemId: run.itemId,
        titleJa: item?.titleJa ?? null,
        titleEn: titleEn.get(`${run.itemType}:${run.itemId}`) ?? null,
        status,
        error,
        startedAt: run.startedAt.toString(),
        updatedAt: updatedAt.toString(),
        snapshot,
        images,
      });
    }

    return Response.json({ runs: entries });
  }
}
