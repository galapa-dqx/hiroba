import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ locals, params }) => {
  const runtime = locals.runtime as {
    env: { WORKFLOW_MANAGER: DurableObjectNamespace };
  };

  const id = params.id!;
  const doId = runtime.env.WORKFLOW_MANAGER.idFromName(id);
  const stub = runtime.env.WORKFLOW_MANAGER.get(doId);

  const res = await stub.fetch('http://internal/trigger', {
    method: 'POST',
    // Admin trigger — force past the page-view re-trigger cooldown.
    body: JSON.stringify({ itemId: id, force: true }),
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await res.json();

  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
