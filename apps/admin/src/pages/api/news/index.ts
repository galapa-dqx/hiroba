/**
 * GET /api/news - Lightweight news list for the admin UI.
 */
import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { listNewsAdmin } from '../../../lib/db-operations';

export const GET: APIRoute = async ({ locals, url }) => {
  const runtime = locals.runtime;
  const db = createDb(runtime.env.DB);

  const category = url.searchParams.get('category') || undefined;
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
  const cursor = url.searchParams.get('cursor') || undefined;
  const language = url.searchParams.get('lang') || undefined;

  const result = await listNewsAdmin(db, { category, limit, cursor, language });

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
};
