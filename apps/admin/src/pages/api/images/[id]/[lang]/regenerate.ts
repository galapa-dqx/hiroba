/**
 * Regenerate one image's localized raster for one language with gpt-image-2:
 *
 *   POST /api/images/<id>/<lang>/regenerate
 *
 * The admin worker holds neither the OpenAI key nor the Cloudflare Images
 * binding, so this proxies to the workflow worker's plain route (which does),
 * running the shared localize step with `force`. Synchronous — the worker
 * awaits the model and returns the fresh image's R2 key, so the editor can
 * show it immediately.
 */

import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ locals, params, request }) => {
  const id = params.id!;
  const lang = params.lang!;
  // Optional quality tier chosen in the editor; the workflow worker validates
  // it and rejects anything gpt-image-2 doesn't accept.
  const body = (await request.json().catch(() => ({}))) as {
    quality?: unknown;
  };

  const res = await locals.runtime.env.WORKFLOW.fetch(
    'http://internal/regenerate-image',
    {
      method: 'POST',
      body: JSON.stringify({
        imageId: Number(id),
        language: lang,
        quality: body.quality,
      }),
      headers: { 'Content-Type': 'application/json' },
    },
  );

  const data = await res.json();
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
