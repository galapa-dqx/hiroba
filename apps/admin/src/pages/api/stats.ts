import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb } from '@hiroba/db';

import { getStats } from '../../lib/stats-queries';

export const GET: APIRoute = async () => {
  const db = createDb(env.DB);

  const stats = await getStats(db);

  return new Response(JSON.stringify(stats), {
    headers: { 'Content-Type': 'application/json' },
  });
};
