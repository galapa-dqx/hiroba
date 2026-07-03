import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { scrapeTopicsBatch } from '../../../lib/db-operations';

export const POST: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const url = new URL(request.url);
  const cursorParam = url.searchParams.get('cursor');
  const batchParam = url.searchParams.get('batch');

  const result = await scrapeTopicsBatch(db, {
    cursor: cursorParam != null ? Number(cursorParam) : undefined,
    batch: batchParam != null ? Number(batchParam) : undefined,
  });

  return new Response(JSON.stringify({ success: true, ...result }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
