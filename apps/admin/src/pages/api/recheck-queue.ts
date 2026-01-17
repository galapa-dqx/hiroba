import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { getRecheckQueue } from '../../lib/db-operations';

export const GET: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const url = new URL(request.url);
  const limit = Math.min(
    parseInt(url.searchParams.get('limit') ?? '50', 10),
    1000,
  );

  const items = await getRecheckQueue(db, limit);

  return new Response(JSON.stringify({ items }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
