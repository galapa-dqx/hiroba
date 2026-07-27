/**
 * Upload a hand-made localized image for one language:
 *
 *   POST /api/images/<id>/<lang>/upload   (multipart/form-data, field `file`)
 *
 * The bytes are stored in R2 at a fresh VERSIONED key (`l10n/<lang>/v<ts>/…`,
 * immutable — see LOCALIZED_IMAGE_CACHE_CONTROL) and recorded as a render (its
 * `images` row + primary `image_files` row, dimensions measured via the Images
 * binding). The render's model is the manual sentinel so the nightly localize
 * step won't overwrite it (an explicit "Regenerate" still can).
 *
 * The admin worker owns the R2 bucket, so the write happens here; the
 * follow-ups — the derived files (Images encoding) and the page purge (zone
 * credentials) — need the workflow worker, so they run as one hub-started
 * ImageFileFlow over the render this route just wrote.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import {
  createDb,
  getEnabledLanguages,
  insertImageRender,
  MANUAL_IMAGE_MODEL,
} from '@hiroba/db';
import { ImageFileFlow } from '@hiroba/flows';
import {
  LOCALIZED_IMAGE_CACHE_CONTROL,
  localizedImageKey,
  measureImage,
} from '@hiroba/shared';

import { startFlowViaHub } from '../../../../../lib/start-flow';

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

  const image = await db.query.imageSources.findFirst({ where: { id } });
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
  // The id is allocated here so the follow-up flow can name this exact render.
  const imageId = crypto.randomUUID();
  const dims = await measureImage(env.IMAGES, bytes);
  await insertImageRender(db, {
    id: imageId,
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

  // Hand the follow-ups to ImageFileFlow: the derived files (AVIF, DQX-49)
  // and the page purge both need capabilities that live on the workflow
  // worker — Images encoding and the zone purge credentials. Order doesn't
  // matter to readers: the web emits only recorded files, so until the flow
  // lands the fresh render serves as a bare <img>. Best-effort — a failed
  // start must not fail the upload (pages then refresh on their own TTL). But
  // note NOTHING revisits this render automatically: this route is the flow's
  // only start site, and nightly localize skips manual-model renders by
  // design — recovery is an operator re-running the flow or re-uploading.
  try {
    await startFlowViaHub(env.FLOW_HUB, ImageFileFlow.name, { imageId });
  } catch (err) {
    console.warn(`upload: image-file start failed for ${localizedKey}:`, err);
  }

  return json({ success: true, localizedKey });
};
