import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { scrapeTopicsBatch } from '../../../lib/db-operations';
import { enqueueTitleTranslation } from '../../../lib/enqueue-titles';

export const POST: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as {
    env: { DB: D1Database; FLOW_HUB: DurableObjectNamespace };
  };
  const db = createDb(runtime.env.DB);

  const url = new URL(request.url);
  const cursorParam = url.searchParams.get('cursor');
  const batchParam = url.searchParams.get('batch');

  const { newItemIds, ...result } = await scrapeTopicsBatch(db, {
    cursor: cursorParam != null ? Number(cursorParam) : undefined,
    batch: batchParam != null ? Number(batchParam) : undefined,
  });

  // Eagerly translate the titles just discovered (mirrors the hourly cron).
  const enqueued = await enqueueTitleTranslation(
    runtime.env.FLOW_HUB,
    'topic',
    newItemIds,
  );

  return new Response(
    JSON.stringify({
      success: true,
      ...result,
      titlesEnqueued: enqueued ? newItemIds.length : 0,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
