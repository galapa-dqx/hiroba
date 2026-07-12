/**
 * Regenerate one image's localized raster for one language with gpt-image-2:
 *
 *   POST /api/images/<id>/<lang>/regenerate
 *
 * The admin worker holds neither the OpenAI key nor the Cloudflare Images
 * binding, so this proxies to the WorkflowManager DO (which does), running the
 * shared localize step with `force`. Synchronous — the DO awaits the model and
 * returns the fresh image's R2 key, so the editor can show it immediately.
 */

import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ locals, params }) => {
  const runtime = locals.runtime as {
    env: { WORKFLOW_MANAGER: DurableObjectNamespace };
  };

  const id = params.id!;
  const lang = params.lang!;
  // Namespaced by kind so image ids (small integers) never collide with the
  // 32-char-hex news/topic ids that share this DO namespace.
  const doId = runtime.env.WORKFLOW_MANAGER.idFromName(`image:${id}`);
  const stub = runtime.env.WORKFLOW_MANAGER.get(doId);

  const res = await stub.fetch('http://internal/regenerate-image', {
    method: 'POST',
    body: JSON.stringify({ imageId: Number(id), language: lang }),
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await res.json();
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
