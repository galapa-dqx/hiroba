import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb } from '@hiroba/db';
import { findMatchingGlossaryEntries } from '@hiroba/db/schema';

export const POST: APIRoute = async ({ request }) => {
  const db = createDb(env.DB);

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
