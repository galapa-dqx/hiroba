import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb } from '@hiroba/db';

import { importGlossaryFromGitHub } from '../../../lib/db-operations';

export const POST: APIRoute = async () => {
  const db = createDb(env.DB);

  const result = await importGlossaryFromGitHub(db);

  return new Response(JSON.stringify({ success: true, ...result }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
