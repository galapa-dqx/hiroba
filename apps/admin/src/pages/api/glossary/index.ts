import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb } from '@hiroba/db';

import { getGlossaryEntries } from '../../../lib/db-operations';

export const GET: APIRoute = async ({ request }) => {
  const db = createDb(env.DB);

  const url = new URL(request.url);
  const lang = url.searchParams.get('lang') ?? undefined;

  const entries = await getGlossaryEntries(db, lang);

  return new Response(JSON.stringify({ entries }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
