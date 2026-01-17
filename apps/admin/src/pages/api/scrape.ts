import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';
import type { Category } from '@hiroba/shared';

import { triggerScrape } from '../../lib/db-operations';

export const POST: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const url = new URL(request.url);
  const full = url.searchParams.get('full') === 'true';
  const category = url.searchParams.get('category') as Category | undefined;

  const result = await triggerScrape(db, { full, category });

  return new Response(
    JSON.stringify({
      success: true,
      ...result,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
