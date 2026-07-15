import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb } from '@hiroba/db';

import { invalidateBody } from '../../../../lib/db-operations';

export const DELETE: APIRoute = async ({ params }) => {
  const db = createDb(env.DB);

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
