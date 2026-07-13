/**
 * Upload a hand-made localized image for one language:
 *
 *   POST /api/images/<id>/<lang>/upload   (multipart/form-data, field `file`)
 *
 * The bytes are stored in R2 at a fresh VERSIONED key (`l10n/<lang>/v<ts>/…`,
 * immutable — see LOCALIZED_IMAGE_CACHE_CONTROL), the image's `url` translation
 * row records the new key, and the pages embedding the image are purged so the
 * new URL reaches readers immediately. The row is marked with the manual
 * sentinel model so the nightly localize step won't overwrite it (an explicit
 * "Regenerate" still can). The admin worker owns the R2 bucket, so no DO hop
 * for the write — only the purge is proxied (the credentials live on the
 * workflow side).
 */

import type { APIRoute } from 'astro';

import {
  createDb,
  getEnabledLanguages,
  getImageById,
  MANUAL_IMAGE_MODEL,
  upsertImageTranslation,
} from '@hiroba/db';
import {
  LOCALIZED_IMAGE_CACHE_CONTROL,
  localizedImageKey,
} from '@hiroba/shared';

/** Formats gpt-image-2 emits / the /img route can serve back verbatim. */
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const MAX_BYTES = 15 * 1024 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  const runtime = locals.runtime as {
    env: {
      DB: D1Database;
      IMAGES_BUCKET: R2Bucket;
      WORKFLOW_MANAGER: DurableObjectNamespace;
    };
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

  const localizedKey = localizedImageKey(
    lang,
    Date.now().toString(36),
    image.key,
  );
  const bytes = await file.arrayBuffer();
  await runtime.env.IMAGES_BUCKET.put(localizedKey, bytes, {
    httpMetadata: {
      contentType: file.type,
      cacheControl: LOCALIZED_IMAGE_CACHE_CONTROL,
    },
  });
  await upsertImageTranslation(db, {
    imageId: id,
    language: lang,
    field: 'url',
    value: localizedKey,
    model: MANUAL_IMAGE_MODEL,
  });

  // Cached article pages still embed the previous version's URL; purge every
  // page carrying this image so the new render is picked up immediately. The
  // purge credentials live only on the workflow side (like the regenerate
  // path), so proxy there — best-effort: a purge failure must not fail the
  // upload (pages then refresh on their own TTL).
  try {
    const doId = runtime.env.WORKFLOW_MANAGER.idFromName(`image:${id}`);
    const stub = runtime.env.WORKFLOW_MANAGER.get(doId);
    await stub.fetch('http://internal/purge-image-pages', {
      method: 'POST',
      body: JSON.stringify({ imageKey: image.key, language: lang }),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.warn(`upload: page purge failed for ${image.key}:`, err);
  }

  return json({ success: true, localizedKey });
};
