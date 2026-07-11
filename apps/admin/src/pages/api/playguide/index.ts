import type { APIRoute } from 'astro';

import { createDb, listPlayguidesAdmin } from '@hiroba/db';

export const GET: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const items = await listPlayguidesAdmin(db);

  return new Response(JSON.stringify({ items }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
