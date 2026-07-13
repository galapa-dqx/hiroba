import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb, listPlayguidesAdmin } from '@hiroba/db';

export const GET: APIRoute = async ({ url }) => {
  const db = createDb(env.DB);

  const language = url.searchParams.get('lang') ?? undefined;
  const items = await listPlayguidesAdmin(db, { language });

  return new Response(JSON.stringify({ items }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
