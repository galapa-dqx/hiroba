/**
 * WorkflowManager - Durable Object for the pipeline SSE streams and the admin
 * run tracker.
 *
 * Since DQX-25 every pipeline runs on the flow framework, so this DO no longer
 * creates or tracks workflow instances — the FlowHub owns dedup (one active
 * run per key), the re-trigger cooldown, and the run registry. What remains
 * here until the DQX-26 teardown:
 *
 * - The domain SSE stream: machine-readable pipeline snapshots for a
 *   (item, language) pair, computed from D1 (see @hiroba/shared's
 *   pipeline-state module), not from run output. D1 is the ground truth:
 *   image rows are shared across topics, so progress can be advanced by a
 *   different item's run — and a client that connects after everything
 *   finished still gets a terminal event. The stream self-heals: an unsettled
 *   item with no active run is started via hub.start.
 * - The admin run tracker (/runs): hub runs merged with the legacy
 *   workflow_runs registry rows (read-only except for settling stale actives;
 *   nothing records new rows — the table drops in DQX-26).
 * - Synchronous single-image regeneration for the admin edit page.
 */

import { DurableObject } from 'cloudflare:workers';
import { Temporal } from 'temporal-polyfill';

import {
  computeImageDetail,
  computeSnapshot,
  createDb,
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
  updateWorkflowRunStatus,
} from '@hiroba/db';
import { getFlowHub, isActiveStatus, type RunInfo } from '@hiroba/flow/hub';
import { ArticleFlow, PlayguideFlow } from '@hiroba/flows';
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

import { purgeImagePages } from './purge';
import { localizeImages } from './steps/localize-images';
import type { Env, ItemType } from './types';

/** How long settled runs stay in the tracker's listing. */
const SETTLED_VISIBLE_HOURS = 24;
/** How long settled rows stay in the legacy registry at all (GC horizon). */
const SETTLED_RETAINED_HOURS = 24 * 7;

/** The body-bearing item types whose pipelines this DO streams. */
const ARTICLE_ITEM_TYPES = ['news', 'topic', 'playguide'] as const;

/** Parse a wire `itemType` string to a pipeline item type (news default). */
function parseItemType(value: string | null | undefined): ItemType {
  return (ARTICLE_ITEM_TYPES as readonly string[]).includes(value ?? '')
    ? (value as ItemType)
    : 'news';
}

/** Topics and playguides carry text-bearing images; news does not. */
const hasImages = (itemType: ItemType): boolean => itemType !== 'news';

/** The hub start arguments for one item's pipeline — playguides run their own
 *  flow keyed by slug; news/topics run the ArticleFlow keyed by type+id. */
function flowStart(
  itemType: ItemType,
  itemId: string,
): { flow: string; params: unknown } {
  return itemType === 'playguide'
    ? { flow: PlayguideFlow.name, params: { slug: itemId } }
    : { flow: ArticleFlow.name, params: { itemId, itemType } };
}

/** The (itemType, itemId) a hub run is about, recovered from its identity. */
function hubRunItem(run: RunInfo): { itemType: ItemType; itemId: string } {
  if (run.flow === PlayguideFlow.name) {
    return { itemType: 'playguide', itemId: run.key };
  }
  // ArticleFlow params travel verbatim through the hub.
  const params = run.params as { itemType?: string; itemId?: string } | null;
  return {
    itemType: parseItemType(params?.itemType),
    itemId: params?.itemId ?? run.key,
  };
}

export class WorkflowManager extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/sse') {
      return this.handleSSE(url);
    }
    if (url.pathname === '/runs') {
      return this.handleRuns();
    }
    if (url.pathname === '/regenerate-image' && request.method === 'POST') {
      return this.handleRegenerateImage(request);
    }
    if (url.pathname === '/purge-image-pages' && request.method === 'POST') {
      return this.handlePurgeImagePages(request);
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
    const itemType = parseItemType(url.searchParams.get('itemType'));

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (event: SSEEvent) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        };

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

          // Unsettled: make sure a run is driving the item. The hub attaches
          // to a run already in flight (the page's fire-and-forget trigger
          // usually won this race) or starts one — the stream is self-healing,
          // so viewing an unprocessed article kicks its pipeline off. A client
          // is actively watching an unsettled article, so `force` past the
          // re-trigger cooldown (which guards degraded *settled* pages) and
          // `probe` a stale-looking active run before attaching to it.
          const { flow, params } = flowStart(itemType, itemId);
          let runId: string | null = null;
          try {
            const result = await getFlowHub(this.env).start(flow, params, {
              force: true,
              probe: true,
            });
            if (!result.throttled) runId = result.runId;
          } catch (error) {
            console.error('Failed to start workflow from SSE:', error);
          }
          if (!runId) {
            send({ type: 'error', error: 'Could not start workflow' });
            controller.close();
            return;
          }

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

            const run = await getFlowHub(this.env).getRun(runId);
            if (!run || !isActiveStatus(run.status)) {
              // The run is finished (or gone); whatever the snapshot says now
              // is all it will ever say (a failed run settles its states in
              // its onFailure hook before reaching this point).
              snapshot = await computeSnapshot(db, itemType, itemId, language);
              emit(snapshot);
              finish(snapshot);
              return;
            }
          }

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

    // The fresh render lives at a NEW versioned URL; what's stale is every
    // cached page still embedding the previous version's URL. Purge them for
    // an immediate refresh (best-effort; no-ops until purge is configured).
    if (result.localized > 0 && localizedKey) {
      await purgeImagePages(this.env, db, image.key, language, {
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

  /**
   * Purge the pages rendering one image in one language, on behalf of the
   * admin worker — a manual upload writes the versioned R2 object and the D1
   * row itself but has no zone id or purge token, so it proxies the page bust
   * here. Best-effort like every purge: a failure means cached pages keep the
   * previous version until their TTL, never a failed upload.
   */
  private async handlePurgeImagePages(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      imageKey?: unknown;
      language?: unknown;
    };
    const imageKey = typeof body.imageKey === 'string' ? body.imageKey : '';
    const language = typeof body.language === 'string' ? body.language : '';
    if (!imageKey || !language) {
      return Response.json(
        { error: 'imageKey (string) and language (string) required' },
        { status: 400 },
      );
    }
    await purgeImagePages(this.env, createDb(this.env.DB), imageKey, language, {
      warn: (m) => console.warn(m),
      debug: () => {},
    });
    return Response.json({ ok: true });
  }

  /**
   * List recent workflow runs for the admin tracker: every still-active run
   * plus runs settled in the last SETTLED_VISIBLE_HOURS, each enriched with
   * its D1 pipeline snapshot and per-image detail.
   *
   * The listing is the hub's (article + playguide flows) merged with what
   * remains of the legacy workflow_runs registry. Registry rows are all
   * legacy now (DQX-25 moved the last writers to the hub; nothing records new
   * ones): keep them only while still active — the pre-cutover in-flight
   * instances the deploy window tolerates — and let settled ones defer to the
   * hub listing instead of shadowing it for a day.
   *
   * Reads only global state (the hub + registry table), so it works from any
   * instance of this DO — callers use a well-known 'registry' instance rather
   * than an item-scoped one.
   */
  private async handleRuns(): Promise<Response> {
    const db = createDb(this.env.DB);
    const now = Temporal.Now.instant();

    await pruneWorkflowRuns(
      db,
      now.subtract({ hours: SETTLED_RETAINED_HOURS }),
    );
    const settledSince = now.subtract({ hours: SETTLED_VISIBLE_HOURS });
    const runs = (await listWorkflowRuns(db, { settledSince })).filter((run) =>
      isRunActive(run.status),
    );

    // The hub owns every run since the cutover. It reconciles its own stale
    // actives lazily; no engine polling here.
    let hubRuns: RunInfo[] = [];
    try {
      const hub = getFlowHub(this.env);
      const listed = await Promise.all([
        hub.listRuns({ flow: ArticleFlow.name }),
        hub.listRuns({ flow: PlayguideFlow.name }),
      ]);
      hubRuns = listed
        .flat()
        .filter(
          (r) =>
            isActiveStatus(r.status) ||
            r.updatedAt >= settledSince.epochMilliseconds,
        );
    } catch (error) {
      console.error('Failed to list flow runs:', error);
    }
    const hubItems = hubRuns.map((run) => ({ run, ...hubRunItem(run) }));

    // Batch the translated titles per item type (cheap title-row-only reads).
    const titleEn = new Map<string, string>();
    for (const itemType of ARTICLE_ITEM_TYPES) {
      const ids = [
        ...runs.filter((r) => r.itemType === itemType).map((r) => r.itemId),
        ...hubItems.filter((h) => h.itemType === itemType).map((h) => h.itemId),
      ];
      const titles = await getTitleTranslations(db, itemType, ids, 'en');
      for (const [id, title] of titles) titleEn.set(`${itemType}:${id}`, title);
    }

    const itemFor = (itemType: ItemType, itemId: string) =>
      itemType === 'topic'
        ? getTopic(db, itemId)
        : itemType === 'playguide'
          ? getPlayguide(db, itemId)
          : getNewsItem(db, itemId);

    const entries: WorkflowRunEntry[] = [];
    for (const run of runs) {
      let status: WorkflowRunStatus = run.status;
      let error = run.error;
      let updatedAt = run.updatedAt;
      // Reconcile the surviving active row against the engine so a pre-cutover
      // straggler settles out of the panel instead of showing running forever
      // (the one write this table still gets — it drops in DQX-26).
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

      const item = await itemFor(run.itemType, run.itemId);
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

    for (const { run, itemType, itemId } of hubItems) {
      const item = await itemFor(itemType, itemId);
      const snapshot = await computeSnapshot(db, itemType, itemId, 'en');
      const images =
        hasImages(itemType) && item
          ? await computeImageDetail(db, item.blocksJa, 'en')
          : [];
      entries.push({
        instanceId: run.runId,
        itemType,
        itemId,
        titleJa: item?.titleJa ?? null,
        titleEn: titleEn.get(`${itemType}:${itemId}`) ?? null,
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
