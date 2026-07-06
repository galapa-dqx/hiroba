import type { APIRoute } from 'astro';

import { createDb, deleteTranslation } from '@hiroba/db';

import { createTranslationPut } from '../../../../lib/article-endpoints';

export const PUT = createTranslationPut('topic');

export const DELETE: APIRoute = async ({ locals, params }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const id = params.id!;
  const lang = params.lang!;

  const success = await deleteTranslation(db, id, lang, 'topic');

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
