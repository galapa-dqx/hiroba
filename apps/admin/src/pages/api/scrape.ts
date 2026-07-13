import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';
import type { StartResult } from '@hiroba/flow/hub';
import { NewsBackfillFlow } from '@hiroba/flows';
import { CATEGORIES, type Category } from '@hiroba/shared';

import { triggerScrape } from '../../lib/db-operations';
import { enqueueTitleTranslation } from '../../lib/enqueue-titles';
import { startErrorMessage, startFlowViaHub } from '../../lib/start-flow';

export const POST: APIRoute = async ({ locals, request }) => {
  const env = locals.runtime.env;

  const url = new URL(request.url);
  const full = url.searchParams.get('full') === 'true';

  // Validated, not cast: the value becomes both the hub dedup key and the
  // flow params — junk would otherwise settle a green `{pages: 0}` run under
  // a junk key instead of failing loudly.
  const categoryParam = url.searchParams.get('category');
  if (
    categoryParam !== null &&
    !(CATEGORIES as readonly string[]).includes(categoryParam)
  ) {
    return Response.json(
      { error: `invalid category: ${categoryParam}` },
      { status: 400 },
    );
  }
  const category = (categoryParam as Category | null) ?? undefined;

  // Whole-archive scrape → start NewsBackfillFlow via the FlowHub, which drains
  // the archive one durable page-unit at a time. A single request can't: the
  // free plan caps subrequests at 50, and a full backfill makes hundreds
  // (that's the 500). The hub dedupes on the scope key (`category ?? 'all'`);
  // `probe` makes the attach verify the run with the engine first, so a
  // silently-dead run is replaced immediately instead of after the lazy
  // reconciler's window — this button has a human watching it.
  // Returns immediately; the client streams the run's hub SSE snapshots from
  // /api/flow-runs/stream?runId=….
  if (full) {
    let result: StartResult;
    try {
      result = await startFlowViaHub(
        env.FLOW_HUB,
        NewsBackfillFlow.name,
        category ? { category } : {},
        { probe: true },
      );
    } catch (err) {
      return Response.json(
        { error: `Failed to start archive scrape: ${startErrorMessage(err)}` },
        { status: 502 },
      );
    }
    if (result.throttled) {
      // Unreachable without a cooldown, but the wire type carries it.
      return Response.json({ status: 'throttled' });
    }
    return Response.json({
      success: true,
      mode: 'workflow',
      status: result.created ? 'started' : 'already_running',
      runId: result.runId,
    });
  }

  // Incremental refresh (first page per category) is only a handful of
  // subrequests — run it inline and enqueue title translation for the newly
  // discovered items, mirroring the hourly cron.
  const db = createDb(env.DB);
  const { newItemIds, ...result } = await triggerScrape(db, { full, category });
  const enqueued = await enqueueTitleTranslation(
    env.FLOW_HUB,
    'news',
    newItemIds,
  );

  return Response.json({
    success: true,
    mode: 'inline',
    ...result,
    titlesEnqueued: enqueued ? newItemIds.length : 0,
  });
};
