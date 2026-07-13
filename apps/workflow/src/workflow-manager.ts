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
  getImageById,
  getImageTranslations,
  getImageTranslationStates,
  getNewsItem,
  getPlayguide,
  getTitleTranslations,
  getTopic,
  listWorkflowRuns,
  MANUAL_IMAGE_MODEL,
  pruneWorkflowRuns,
  recordWorkflowRun,
  updateWorkflowRunStatus,
} from '@hiroba/db';
import { getFlowHub, isActiveStatus } from '@hiroba/flow/hub';
import { PlayguideFlow } from '@hiroba/flows';
import { imageUpstreamUrl, type Block } from '@hiroba/richtext';
import {
  describeSnapshot,
  isRunActive,
  isSnapshotSettled,
  type SSEEvent,
  type StateSnapshot,
  type WorkflowRunEntry,
  type WorkflowRunStatus,
} from '@hiroba/shared';

import { purgeImage } from './purge';
import { localizeImages } from './steps/localize-images';
import type { Env, ItemType } from './types';

/** How long settled runs stay in the tracker's listing. */
const SETTLED_VISIBLE_HOURS = 24;
/** How long settled rows stay in the registry at all (GC horizon). */
const SETTLED_RETAINED_HOURS = 24 * 7;

/**
 * Minimum gap between page-driven pipeline re-triggers for one article. A
 * settled-but-degraded article (e.g. an image the model can't produce) is not
 * `complete`, so every organic view would otherwise start a fresh pipeline —
 * full LLM/image work scaling with traffic. Throttling to one attempt per
 * window caps re-run cost at the size of the catalogue, not the traffic to it.
 * Genuine self-healing still happens (just not on every hit); admin and cron
 * bypass this with `force`.
 */
export const RETRIGGER_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

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
    if (url.pathname === '/regenerate-image' && request.method === 'POST') {
      return this.handleRegenerateImage(request);
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
            // A client is actively watching an unsettled article, so force past
            // the re-trigger cooldown (which guards degraded *settled* pages).
            active =
              (await this.ensureArticleWorkflow(itemId, itemType, {
                force: true,
              })) ?? undefined;
            if (!active) {
              send({ type: 'error', error: 'Could not start workflow' });
              controller.close();
              return;
            }
          }

          const pollInterval = 1000;
          const maxPolls = 300; // 5 minutes

          // Whether the run driving this item has settled — playguides run on
          // the flow framework (DQX-24), so their status lives at the hub.
          // News/topics ask the Workflows engine.
          const runFinished = async (run: Active): Promise<boolean> => {
            if (run.itemType === 'playguide') {
              const info = await getFlowHub(this.env).getRun(run.instanceId);
              if (info) return !isActiveStatus(info.status);
              // Unknown to the hub: the one way that happens is a
              // pre-cutover ArticleWorkflow instance this (not-yet-restarted)
              // DO still remembers in memory — fall through and ask the old
              // engine about it rather than declaring a live straggler done.
            }
            const instance = await this.env.ARTICLE_WORKFLOW.get(
              run.instanceId,
            );
            const status = await instance.status();
            return (
              status.status === 'complete' ||
              status.status === 'errored' ||
              status.status === 'terminated'
            );
          };

          for (let i = 0; i < maxPolls; i++) {
            await new Promise((resolve) => setTimeout(resolve, pollInterval));

            snapshot = await computeSnapshot(db, itemType, itemId, language);
            emit(snapshot);
            if (isSnapshotSettled(snapshot)) {
              finish(snapshot);
              return;
            }

            if (await runFinished(active)) {
              // The workflow is finished; whatever the snapshot says now is
              // all it will ever say (errored workflows settle their states in
              // their failure handler before reaching this point).
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
      force?: boolean;
    };
    const { itemId } = body;
    const itemType: ItemType = body.itemType ?? 'news';

    if (!itemId) {
      return Response.json({ error: 'itemId required' }, { status: 400 });
    }

    // Admin and cron set `force` to bypass the re-trigger cooldown; page views
    // leave it unset, so a settled-but-degraded article throttles instead of
    // re-running its pipeline on every visit.
    const active = await this.ensureArticleWorkflow(itemId, itemType, {
      force: body.force ?? false,
    });
    if (!active) {
      return Response.json({ status: 'throttled' });
    }
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
    { force = false }: { force?: boolean } = {},
  ): Promise<Active | null> {
    // Playguides run on the flow framework (DQX-24). The hub owns dedup (one
    // active run per slug key), the re-trigger cooldown, and the run registry
    // — everything the durable path below does for news/topics — so this is a
    // straight delegation, outside blockConcurrencyWhile (the hub start is
    // itself race-safe). `probe` verifies a stale-looking active run against
    // the engine before attaching: this path is only hit from the self-healing
    // SSE stream and stray internal triggers, where someone is watching.
    if (itemType === 'playguide') {
      const result = await getFlowHub(this.env).start(
        PlayguideFlow.name,
        { slug: itemId },
        { force, cooldownMs: RETRIGGER_COOLDOWN_MS, probe: true },
      );
      if (result.throttled) return null;
      const active: Active = { instanceId: result.runId, itemType };
      this.activeWorkflows.set(itemId, active);
      return active;
    }
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

      // No run is in flight. Throttle page-driven re-triggers here (after the
      // dedup checks, so an in-flight run is always reused regardless): without
      // this, a settled-but-incomplete article starts a fresh pipeline on every
      // organic view. One attempt per cooldown window is plenty for genuine
      // self-healing; `force` (admin/cron) skips it.
      if (!force) {
        const last = await this.ctx.storage.get<number>(
          `retrigger:${itemType}:${itemId}`,
        );
        if (last != null && Date.now() - last < RETRIGGER_COOLDOWN_MS) {
          return null;
        }
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
      // Stamp the attempt so the cooldown above throttles the next organic
      // re-trigger (a forced run resets the window too — harmless).
      await this.ctx.storage.put(`retrigger:${itemType}:${itemId}`, Date.now());
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
   * Regenerate one image's localized raster for one language with gpt-image-2,
   * synchronously — the admin edit page awaits the fresh image. Runs the shared
   * localize step (which reads the current translated spans from D1) with
   * `force`, so it redoes an image even if it's already localized or manually
   * overridden. Bounded work: a single image × single language.
   *
   * This DO holds the OpenAI key and the Images binding the admin worker lacks,
   * which is why regeneration is proxied here rather than done in the admin app.
   */
  private async handleRegenerateImage(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      imageId?: unknown;
      language?: unknown;
    };
    const imageId =
      typeof body.imageId === 'number' ? body.imageId : Number(body.imageId);
    const language = typeof body.language === 'string' ? body.language : '';
    if (!Number.isInteger(imageId) || !language) {
      return Response.json(
        { error: 'imageId (number) and language required' },
        { status: 400 },
      );
    }

    const db = createDb(this.env.DB);
    const image = await getImageById(db, imageId);
    if (!image) {
      return Response.json({ error: 'Image not found' }, { status: 404 });
    }

    // The label is what the prompt says to translate into; take it from the
    // whitelist so an admin can't regenerate into a disabled/unknown language.
    const languages = await getEnabledLanguages(db);
    const target = languages.find((l) => l.code === language);
    if (!target) {
      return Response.json(
        { error: `Language '${language}' is not enabled` },
        { status: 400 },
      );
    }

    // The shared step operates on a block tree; wrap the image in a minimal node.
    const blocks: Block[] = [
      { type: 'image', src: imageUpstreamUrl(image.key) },
    ];
    // Force past any existing (or manual) row, and stamp the result manual so —
    // like an upload — an operator's regeneration survives the nightly refresh.
    const result = await localizeImages(
      db,
      this.env.IMAGES_BUCKET,
      this.env.IMAGES,
      this.env.OPENAI_API_KEY,
      blocks,
      [{ code: target.code, label: target.label }],
      { force: true, model: MANUAL_IMAGE_MODEL },
    );

    // Report the url row's settled state so the client can show the new image
    // or the failure reason without a second round-trip.
    const states = await getImageTranslationStates(
      db,
      [imageId],
      language,
      'url',
    );
    const values = await getImageTranslations(db, [imageId], language, 'url');
    const state = states.get(imageId) ?? null;
    const localizedKey = values.get(imageId) ?? null;

    // The localized image lives at a stable URL, so a browser/edge copy of the
    // old raster would otherwise linger past this edit. Bust it now for an
    // immediate refresh (best-effort; no-ops until purge is configured).
    if (result.localized > 0 && localizedKey) {
      await purgeImage(this.env, localizedKey, {
        warn: (m) => console.warn(m),
        debug: () => {},
      });
    }

    return Response.json({
      status: result.localized > 0 ? 'done' : 'failed',
      state,
      localizedKey,
    });
  }

  /** Handle status request. */
  private async handleStatus(itemId: string): Promise<Response> {
    const active = this.activeWorkflows.get(itemId);
    if (!active) return Response.json({ status: 'idle' });

    // Playguide handles are hub run ids (DQX-24), not engine instances. A
    // hub miss falls through to the legacy engine lookup below — the same
    // straggler posture as the SSE stream's runFinished (a warm DO can still
    // be tracking a pre-cutover ArticleWorkflow instance).
    if (active.itemType === 'playguide') {
      const info = await getFlowHub(this.env).getRun(active.instanceId);
      if (info) {
        return Response.json({
          // The hub's one non-engine status name, mapped to this wire type's.
          status: info.status === 'failed' ? 'errored' : info.status,
          instanceId: active.instanceId,
          output: info.output,
          error: info.error ?? undefined,
        });
      }
    }

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
    const settledSince = now.subtract({ hours: SETTLED_VISIBLE_HOURS });
    // Playguide registry rows are legacy (DQX-24 moved the type to the hub;
    // nothing records new ones): keep them only while still active — the
    // pre-deploy in-flight instances the cutover tolerates — and let settled
    // ones defer to the hub listing below instead of shadowing it for a day.
    const runs = (await listWorkflowRuns(db, { settledSince })).filter(
      (run) => run.itemType !== 'playguide' || isRunActive(run.status),
    );

    // Playguide runs live at the FlowHub (DQX-24), not in the workflow_runs
    // registry — merge them in with the same visibility window so the edit
    // page's run tracking and this panel keep working unchanged. The hub
    // reconciles its own stale actives lazily; no engine polling here.
    let playguideRuns: Awaited<
      ReturnType<ReturnType<typeof getFlowHub>['listRuns']>
    > = [];
    try {
      const hubRuns = await getFlowHub(this.env).listRuns({
        flow: PlayguideFlow.name,
      });
      playguideRuns = hubRuns.filter(
        (r) =>
          isActiveStatus(r.status) ||
          r.updatedAt >= settledSince.epochMilliseconds,
      );
    } catch (error) {
      console.error('Failed to list playguide flow runs:', error);
    }

    // Batch the translated titles per item type (cheap title-row-only reads).
    const titleEn = new Map<string, string>();
    for (const itemType of ARTICLE_ITEM_TYPES) {
      const ids = runs
        .filter((r) => r.itemType === itemType)
        .map((r) => r.itemId);
      if (itemType === 'playguide') {
        ids.push(...playguideRuns.map((r) => r.key));
      }
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

    for (const run of playguideRuns) {
      const slug = run.key;
      const item = await getPlayguide(db, slug);
      const snapshot = await computeSnapshot(db, 'playguide', slug, 'en');
      const images = item
        ? await computeImageDetail(db, item.blocksJa, 'en')
        : [];
      entries.push({
        instanceId: run.runId,
        itemType: 'playguide',
        itemId: slug,
        titleJa: item?.titleJa ?? null,
        titleEn: titleEn.get(`playguide:${slug}`) ?? null,
        // The hub's one non-engine status name: its 'failed' is the engine's
        // (and this wire type's) 'errored'.
        status: run.status === 'failed' ? 'errored' : run.status,
        error: run.error,
        startedAt: Temporal.Instant.fromEpochMilliseconds(
          run.createdAt,
        ).toString(),
        updatedAt: Temporal.Instant.fromEpochMilliseconds(
          run.updatedAt,
        ).toString(),
        snapshot,
        images,
      });
    }

    // Registry rows come back newest-first; keep that order across the merge.
    entries.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

    return Response.json({ runs: entries });
  }
}
