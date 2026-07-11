import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime as {
    env: { WORKFLOW_MANAGER: DurableObjectNamespace };
  };

  // A dedicated well-known instance so the DO's dedup field is authoritative.
  const stub = runtime.env.WORKFLOW_MANAGER.get(
    runtime.env.WORKFLOW_MANAGER.idFromName('banners'),
  );
  const res = await stub.fetch('http://internal/refresh-banners', {
    method: 'POST',
  });
  const data = await res.json();

  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
