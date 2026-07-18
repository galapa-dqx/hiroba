/**
 * Upload a hand-made localized image for one language:
 *
 *   POST /api/images/<id>/<lang>/upload   (multipart/form-data, field `file`)
 *
 * The bytes are stored in R2 at a fresh VERSIONED key (`l10n/<lang>/v<ts>/…`,
 * immutable — see LOCALIZED_IMAGE_CACHE_CONTROL) and the image's `url`
 * translation row records the new key, marked with the manual sentinel model
 * so the nightly localize step won't overwrite it (an explicit "Regenerate"
 * still can). The admin worker owns the R2 bucket, so the write happens here;
 * the follow-ups — variant registration (Images binding) and the page purge
 * (zone credentials) — need the workflow worker, so they run as one
 * hub-started ImageVariantFlow.
 */

import { startFlowViaHub } from '@/lib/start-flow';
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import {
  createDb,
  getEnabledLanguages,
  getImageById,
  MANUAL_IMAGE_MODEL,
  upsertImageTranslation,
} from '@hiroba/db';
import { ImageVariantFlow } from '@hiroba/flows';
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

export const POST: APIRoute = async ({ params, request }) => {
  const db = createDb(env.DB);

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

  // The uploaded type corrects the key's inherited extension (a PNG replacing
  // a `.jpg` original lands at a `.png` URL — the extension stays truthful).
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
  await upsertImageTranslation(db, {
    imageId: id,
    language: lang,
    field: 'url',
    value: localizedKey,
    model: MANUAL_IMAGE_MODEL,
  });

  // Hand the follow-ups to ImageVariantFlow: measure + AVIF variant +
  // image_sources rows, then the page purge — both need capabilities that
  // live on the workflow worker (Images binding, purge credentials). Order
  // doesn't matter: the web renders only recorded rows, so until the flow
  // lands the fresh render serves as a bare <img>. Best-effort — a failed
  // start must not fail the upload (pages then refresh on their own TTL,
  // variants on the next backfill sweep).
  try {
    await startFlowViaHub(env.FLOW_HUB, ImageVariantFlow.name, {
      key: localizedKey,
      imageKey: image.key,
      language: lang,
    });
  } catch (err) {
    console.warn(
      `upload: image-variant start failed for ${localizedKey}:`,
      err,
    );
  }

  return json({ success: true, localizedKey });
};
