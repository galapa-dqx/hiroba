/**
 * Save the translated spans for one image in one language — the JA→target pairs
 * the operator edits on the image screen:
 *
 *   PUT /api/images/<id>/<lang>   { texts: string[] }
 *
 * `texts` is index-aligned to the image's `texts_ja`, so its length must match.
 * The value is written to the image's `text` translation row (marked as a manual
 * edit); it only reaches the rendered image once the operator regenerates.
 */

import type { APIRoute } from 'astro';

import {
  createDb,
  getEnabledLanguages,
  getImageById,
  MANUAL_IMAGE_MODEL,
  upsertImageTranslation,
} from '@hiroba/db';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const PUT: APIRoute = async ({ locals, params, request }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
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

  const body = (await request.json().catch(() => null)) as {
    texts?: unknown;
  } | null;
  const texts = body?.texts;
  if (
    !Array.isArray(texts) ||
    !texts.every((t): t is string => typeof t === 'string')
  ) {
    return json({ error: 'texts must be an array of strings' }, 400);
  }

  // Spans are index-aligned to the source transcription — a mismatched length
  // would misalign the JA→target pairs the localizer zips together.
  const jaLen = image.textsJa?.length ?? 0;
  if (texts.length !== jaLen) {
    return json({ error: `expected ${jaLen} spans, got ${texts.length}` }, 400);
  }

  await upsertImageTranslation(db, {
    imageId: id,
    language: lang,
    field: 'text',
    value: JSON.stringify(texts),
    model: MANUAL_IMAGE_MODEL,
  });

  return json({ success: true, id, language: lang });
};
