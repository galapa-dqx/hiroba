/**
 * SSE endpoint for topics workflow progress. Proxies to the WorkflowManager DO,
 * namespaced by `topic:` so it doesn't collide with the news DO of the same id.
 */

import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals, params }) => {
  const runtime = locals.runtime;
  const id = params.id!;

  const doId = runtime.env.WORKFLOW_MANAGER.idFromName(`topic:${id}`);
  const stub = runtime.env.WORKFLOW_MANAGER.get(doId);

  const res = await stub.fetch(`http://internal/sse?itemId=${id}`);

  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
};
