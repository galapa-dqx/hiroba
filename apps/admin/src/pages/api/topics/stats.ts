import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { getTopicStats } from '../../../lib/db-operations';

export const GET: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const stats = await getTopicStats(db);

  return new Response(JSON.stringify(stats), {
    headers: { 'Content-Type': 'application/json' },
  });
};
