/**
 * SSE endpoint for workflow progress updates.
 *
 * Proxies SSE connection to the WorkflowManager DO for the given news item.
 */

import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals, params }) => {
  const runtime = locals.runtime as {
    env: { WORKFLOW_MANAGER: DurableObjectNamespace };
  };
  const id = params.id!;

  const doId = runtime.env.WORKFLOW_MANAGER.idFromName(id);
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
