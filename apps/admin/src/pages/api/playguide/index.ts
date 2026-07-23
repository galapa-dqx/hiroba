import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb } from '@hiroba/db';

import { listPlayguidesAdmin } from '../../../lib/article-list-queries';

export const GET: APIRoute = async ({ url }) => {
  const db = createDb(env.DB);

  const language = url.searchParams.get('lang') ?? undefined;
  const items = await listPlayguidesAdmin(db, { language });

  return new Response(JSON.stringify({ items }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
