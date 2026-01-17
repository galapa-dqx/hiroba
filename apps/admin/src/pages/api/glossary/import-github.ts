import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { importGlossaryFromGitHub } from '../../../lib/db-operations';

export const POST: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const result = await importGlossaryFromGitHub(db);

  return new Response(JSON.stringify({ success: true, ...result }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
