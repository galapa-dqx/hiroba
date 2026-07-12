/**
 * Upload a hand-made localized image for one language:
 *
 *   POST /api/images/<id>/<lang>/upload   (multipart/form-data, field `file`)
 *
 * The bytes are stored in R2 at `l10n/<lang>/<key>` — the same slot the pipeline
 * would write — and the image's `url` translation row is marked with the manual
 * sentinel model so the nightly localize step won't overwrite it (an explicit
 * "Regenerate" still can). The admin worker owns the R2 bucket, so no DO hop.
 */

import type { APIRoute } from 'astro';

import {
  createDb,
  getEnabledLanguages,
  getImageById,
  MANUAL_IMAGE_MODEL,
  upsertImageTranslation,
} from '@hiroba/db';

/** Formats gpt-image-2 emits / the /img route can serve back verbatim. */
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const MAX_BYTES = 15 * 1024 * 1024;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  const runtime = locals.runtime as {
    env: { DB: D1Database; IMAGES_BUCKET: R2Bucket };
  };
  const db = createDb(runtime.env.DB);

  const id = Number(params.id);
  const lang = params.lang!;
  if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);

  const image = await getImageById(db, id);
  if (!image) return json({ error: 'Not found' }, 404);

  const enabled = await getEnabledLanguages(db);
  if (!enabled.some((l) => l.code === lang)) {
    return json({ error: `Language '${lang}' is not enabled` }, 400);
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return json({ error: 'file is required' }, 400);
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return json({ error: `unsupported type '${file.type || 'unknown'}'` }, 415);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: 'file exceeds 15MB' }, 413);
  }

  const localizedKey = `l10n/${lang}/${image.key}`;
  const bytes = await file.arrayBuffer();
  await runtime.env.IMAGES_BUCKET.put(localizedKey, bytes, {
    httpMetadata: { contentType: file.type, cacheControl: CACHE_CONTROL },
  });
  await upsertImageTranslation(db, {
    imageId: id,
    language: lang,
    field: 'url',
    value: localizedKey,
    model: MANUAL_IMAGE_MODEL,
  });

  return json({ success: true, localizedKey });
};
