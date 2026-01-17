import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { invalidateBody } from '../../../../lib/db-operations';

export const DELETE: APIRoute = async ({ locals, params }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const id = params.id!;
  const success = await invalidateBody(db, id);

  if (!success) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true, id }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
