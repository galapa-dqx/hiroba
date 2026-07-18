/**
 * Resolve an image's natural key (imageKey `<host>/<path>`) to its surrogate
 * id, so the article editor can jump from an inline image straight to its
 * image-edit screen (`/images/<id>`):
 *
 *   GET /api/images/resolve?key=cache.hiroba.dqx.jp/dq_resource/…
 *
 * 404 when the image isn't in the library yet (only mirrored/transcribed
 * images get a row — the pipeline creates them).
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb, getImageSourcesByKeys } from '@hiroba/db';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const db = createDb(env.DB);

  const key = url.searchParams.get('key');
  if (!key) return json({ error: 'Missing key' }, 400);

  const [image] = await getImageSourcesByKeys(db, [key]);
  if (!image) return json({ error: 'Not found' }, 404);

  return json({ id: image.id, key: image.key });
};
