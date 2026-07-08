import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { getRecheckQueue } from '../../lib/db-operations';

export const GET: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const url = new URL(request.url);
  const dueLimit = Math.min(
    parseInt(url.searchParams.get('limit') ?? '100', 10),
    1000,
  );
  const upcomingLimit = Math.min(
    parseInt(url.searchParams.get('upcoming') ?? '25', 10),
    100,
  );

  const queue = await getRecheckQueue(db, { dueLimit, upcomingLimit });

  return new Response(JSON.stringify(queue), {
    headers: { 'Content-Type': 'application/json' },
  });
};
