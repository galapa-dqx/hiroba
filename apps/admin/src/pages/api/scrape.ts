import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';
import type { Category } from '@hiroba/shared';

import { triggerScrape } from '../../lib/db-operations';
import { enqueueTitleTranslation } from '../../lib/enqueue-titles';
import { newsScrapeStreamKey } from '../../lib/sse';

export const POST: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as {
    env: { DB: D1Database; WORKFLOW_MANAGER: DurableObjectNamespace };
  };

  const url = new URL(request.url);
  const full = url.searchParams.get('full') === 'true';
  const category = url.searchParams.get('category') as Category | undefined;

  // Whole-archive scrape → hand off to the NewsBackfillWorkflow, which pages the
  // archive one durable step at a time. A single request can't: the free plan
  // caps subrequests at 50, and a full backfill makes hundreds (that's the 500).
  // Returns immediately; the client streams progress from /api/scrape/stream.
  if (full) {
    const streamKey = newsScrapeStreamKey(category);
    const stub = runtime.env.WORKFLOW_MANAGER.get(
      runtime.env.WORKFLOW_MANAGER.idFromName(streamKey),
    );
    const res = await stub.fetch('http://internal/scrape-news', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, streamKey }),
    });
    const started = (await res.json()) as {
      status: string;
      instanceId: string;
    };
    return Response.json({
      success: true,
      mode: 'workflow',
      streamKey,
      ...started,
    });
  }

  // Incremental refresh (first page per category) is only a handful of
  // subrequests — run it inline and enqueue title translation for the newly
  // discovered items, mirroring the hourly cron.
  const db = createDb(runtime.env.DB);
  const { newItemIds, ...result } = await triggerScrape(db, { full, category });
  const enqueued = await enqueueTitleTranslation(
    runtime.env.WORKFLOW_MANAGER,
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
