import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { triggerRecentWorkflows } from '../../../lib/trigger-recent';

export const POST: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as {
    env: { DB: D1Database; FLOW_HUB: DurableObjectNamespace };
  };

  const count = Number(new URL(request.url).searchParams.get('count'));
  if (!Number.isFinite(count) || count < 1) {
    return new Response(
      JSON.stringify({ error: 'count must be a positive integer' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const result = await triggerRecentWorkflows(
    createDb(runtime.env.DB),
    runtime.env.FLOW_HUB,
    'news',
    count,
  );

  return new Response(JSON.stringify({ success: true, ...result }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
