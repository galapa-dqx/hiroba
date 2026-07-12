import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { listTopicsAdmin } from '../../../lib/db-operations';

export const GET: APIRoute = async ({ locals, url }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
  const cursor = url.searchParams.get('cursor') || undefined;
  const language = url.searchParams.get('lang') || undefined;

  const result = await listTopicsAdmin(db, { limit, cursor, language });

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
};
