/**
 * Upload a hand-made localized image for one language:
 *
 *   POST /api/images/<id>/<lang>/upload   (multipart/form-data, field `file`)
 *
 * The bytes are stored in R2 at a fresh VERSIONED key (`l10n/<lang>/v<ts>/…`,
 * immutable — see LOCALIZED_IMAGE_CACHE_CONTROL), recorded as a render (its
 * `images` row + primary `image_files` row, dimensions measured via the Images
 * binding), and the pages embedding the image are purged so the new URL reaches
 * readers immediately. The render's model is the manual sentinel so the nightly
 * localize step won't overwrite it (an explicit "Regenerate" still can). The
 * admin worker owns the R2 bucket, so the write happens here — only the page
 * purge is proxied over the WORKFLOW service binding (the purge credentials live
 * on the workflow worker).
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import {
  createDb,
  getEnabledLanguages,
  getImageSourceById,
  insertImageRender,
  MANUAL_IMAGE_MODEL,
} from '@hiroba/db';
import {
  LOCALIZED_IMAGE_CACHE_CONTROL,
  localizedImageKey,
  measureImage,
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

export const POST: APIRoute = async ({ params, request }) => {
  const db = createDb(env.DB);

  const id = Number(params.id);
  const lang = params.lang!;
  if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);

  const image = await getImageSourceById(db, id);
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

  // Versioned key with an extension corrected to the uploaded content type
  // (the source path's extension may lie about the stored bytes).
  const localizedKey = localizedImageKey(
    lang,
    Date.now().toString(36),
    image.key,
    file.type,
  );
  const bytes = await file.arrayBuffer();
  await env.IMAGES_BUCKET.put(localizedKey, bytes, {
    httpMetadata: {
      contentType: file.type,
      cacheControl: LOCALIZED_IMAGE_CACHE_CONTROL,
    },
  });

  // Record the render + its primary file (dims measured) in one atomic batch.
  const dims = await measureImage(env.IMAGES, bytes);
  await insertImageRender(db, {
    id: crypto.randomUUID(),
    sourceId: id,
    language: lang,
    model: MANUAL_IMAGE_MODEL,
    files: [
      {
        key: localizedKey,
        isPrimary: true,
        mime: dims.mime ?? file.type,
        width: dims.width,
        height: dims.height,
        bytes: bytes.byteLength,
      },
    ],
  });

  // Cached article pages still embed the previous version's URL; purge every
  // page carrying this image so the new render is picked up immediately. The
  // purge credentials live only on the workflow side (like the regenerate
  // path), so proxy there — best-effort: a purge failure must not fail the
  // upload (pages then refresh on their own TTL).
  try {
    const res = await env.WORKFLOW.fetch('http://internal/purge-image-pages', {
      method: 'POST',
      body: JSON.stringify({ imageKey: image.key, language: lang }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      console.warn(
        `upload: page purge failed for ${image.key} (${res.status}): ${await res.text().catch(() => '')}`,
      );
    }
  } catch (err) {
    console.warn(`upload: page purge failed for ${image.key}:`, err);
  }

  return json({ success: true, localizedKey });
};
