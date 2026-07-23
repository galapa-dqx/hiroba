/**
 * GET /api/news - Lightweight news list for the admin UI.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb } from '@hiroba/db';

import { listNewsAdmin } from '../../../lib/article-list-queries';

export const GET: APIRoute = async ({ url }) => {
  const db = createDb(env.DB);

  const category = url.searchParams.get('category') || undefined;
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
  const cursor = url.searchParams.get('cursor') || undefined;
  const language = url.searchParams.get('lang') || undefined;

  const result = await listNewsAdmin(db, { category, limit, cursor, language });

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
};
