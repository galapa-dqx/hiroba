import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';
import { findMatchingGlossaryEntries } from '@hiroba/db/schema';

export const POST: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const body = await request.json();
  const { text, lang = 'en' } = body as { text: string; lang?: string };

  if (!text || typeof text !== 'string') {
    return new Response(JSON.stringify({ error: 'text is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const matches = await findMatchingGlossaryEntries(db, text, lang);

  return new Response(JSON.stringify({ matches }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
