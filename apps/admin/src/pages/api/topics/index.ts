import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb } from '@hiroba/db';

import { listTopicsAdmin } from '../../../lib/article-list-queries';

export const GET: APIRoute = async ({ url }) => {
  const db = createDb(env.DB);

  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
  const cursor = url.searchParams.get('cursor') || undefined;
  const language = url.searchParams.get('lang') || undefined;

  const result = await listTopicsAdmin(db, { limit, cursor, language });

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
};
