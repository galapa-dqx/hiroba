import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb } from '@hiroba/db';

import { triggerRecentWorkflows } from '../../../lib/trigger-recent';

export const POST: APIRoute = async ({ request }) => {
  const count = Number(new URL(request.url).searchParams.get('count'));
  if (!Number.isFinite(count) || count < 1) {
    return new Response(
      JSON.stringify({ error: 'count must be a positive integer' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const result = await triggerRecentWorkflows(
    createDb(env.DB),
    env.FLOW_HUB,
    'topic',
    count,
  );

  return new Response(JSON.stringify({ success: true, ...result }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
