import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb } from '@hiroba/db';

import { createTranslationPut } from '../../../../lib/article-endpoints';
import { deleteTranslation } from '../../../../lib/db-operations';

export const PUT = createTranslationPut('news');

export const DELETE: APIRoute = async ({ params }) => {
  const db = createDb(env.DB);

  const id = params.id!;
  const lang = params.lang!;

  const success = await deleteTranslation(db, id, lang);

  if (!success) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true, id, language: lang }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
