import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';
import type { Category } from '@hiroba/shared';

import { triggerScrape } from '../../lib/db-operations';
import { enqueueTitleTranslation } from '../../lib/enqueue-titles';

export const POST: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as {
    env: { DB: D1Database; WORKFLOW_MANAGER: DurableObjectNamespace };
  };
  const db = createDb(runtime.env.DB);

  const url = new URL(request.url);
  const full = url.searchParams.get('full') === 'true';
  const category = url.searchParams.get('category') as Category | undefined;

  const { newItemIds, ...result } = await triggerScrape(db, {
    full,
    category,
  });

  // Eagerly translate the titles just discovered (mirrors the hourly cron).
  const enqueued = await enqueueTitleTranslation(
    runtime.env.WORKFLOW_MANAGER,
    'news',
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
