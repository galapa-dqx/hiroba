import type { APIRoute } from 'astro';

import { createDb, listPlayguidesAdmin } from '@hiroba/db';

export const GET: APIRoute = async ({ locals, url }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const language = url.searchParams.get('lang') ?? undefined;
  const items = await listPlayguidesAdmin(db, { language });

  return new Response(JSON.stringify({ items }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
