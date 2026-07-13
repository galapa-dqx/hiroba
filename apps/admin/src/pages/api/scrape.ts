import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';
import type { StartResult } from '@hiroba/flow/hub';
import { NewsBackfillFlow } from '@hiroba/flows';
import type { Category } from '@hiroba/shared';

import { triggerScrape } from '../../lib/db-operations';
import { enqueueTitleTranslation } from '../../lib/enqueue-titles';

export const POST: APIRoute = async ({ locals, request }) => {
  const env = locals.runtime.env;

  const url = new URL(request.url);
  const full = url.searchParams.get('full') === 'true';
  const category = url.searchParams.get('category') as Category | undefined;

  // Whole-archive scrape → start NewsBackfillFlow via the FlowHub, which drains
  // the archive one durable page-unit at a time. A single request can't: the
  // free plan caps subrequests at 50, and a full backfill makes hundreds
  // (that's the 500). The hub dedupes on the scope key (`category ?? 'all'`),
  // so re-triggering a scope still in flight attaches to the running scrape.
  // Returns immediately; the client streams the run's hub SSE snapshots from
  // /api/flow-runs/stream?runId=….
  if (full) {
    const ns = env.FLOW_HUB;
    const stub = ns.get(ns.idFromName('hub'));
    const res = await stub.fetch('http://internal/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flow: NewsBackfillFlow.name,
        params: category ? { category } : {},
      }),
    });
    if (!res.ok) {
      return Response.json(
        { error: 'Failed to start archive scrape' },
        { status: 502 },
      );
    }
    const result = (await res.json()) as StartResult;
    if (result.throttled) {
      // Unreachable without a cooldown, but the wire type carries it.
      return Response.json({ error: 'throttled' }, { status: 429 });
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
