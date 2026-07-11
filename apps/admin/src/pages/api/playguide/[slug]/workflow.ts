import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ locals, params }) => {
  const runtime = locals.runtime as {
    env: { WORKFLOW_MANAGER: DurableObjectNamespace };
  };

  const slug = params.slug!;
  // Namespaced by type so playguide slugs don't collide with news/topic ids.
  const doId = runtime.env.WORKFLOW_MANAGER.idFromName(`playguide:${slug}`);
  const stub = runtime.env.WORKFLOW_MANAGER.get(doId);

  const res = await stub.fetch('http://internal/trigger', {
    method: 'POST',
    body: JSON.stringify({ itemId: slug, itemType: 'playguide' }),
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await res.json();

  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
