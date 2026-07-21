/**
 * Restructure an image's Japanese spans — the rows of the JA→target pair editor:
 *
 *   PUT /api/images/<id>/texts   { spans: [{ text, from }, …] }
 *
 * `spans` is the new `texts_ja` in order; each entry's `from` is the index that
 * row occupies in the CURRENT texts_ja (null for a row just added). The mapping
 * is what makes a mid-list delete safe: every language's translated spans are
 * index-aligned to texts_ja, so they are realigned through the same mapping
 * (see restructureImageTexts). This edits the SOURCE — it affects every
 * language, not just the one on screen.
 *
 * Translations for a dropped span are dropped with it; the localized rasters are
 * left alone until the operator regenerates.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import {
  createDb,
  restructureImageTexts,
  type ImageSpanEdit,
} from '@hiroba/db';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const PUT: APIRoute = async ({ params, request }) => {
  const db = createDb(env.DB);

  const id = Number(params.id);
  if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);

  const image = await db.query.imageSources.findFirst({ where: { id } });
  if (!image) return json({ error: 'Not found' }, 404);

  const body = (await request.json().catch(() => null)) as {
    spans?: unknown;
  } | null;
  const spans = body?.spans;
  if (!Array.isArray(spans)) {
    return json({ error: 'spans must be an array' }, 400);
  }

  const jaLen = image.textsJa?.length ?? 0;
  const seen = new Set<number>();
  for (const span of spans) {
    if (
      typeof span !== 'object' ||
      span === null ||
      typeof (span as ImageSpanEdit).text !== 'string'
    ) {
      return json({ error: 'each span needs a text string' }, 400);
    }
    const from = (span as ImageSpanEdit).from;
    if (from === null || from === undefined) continue;
    // A `from` outside the current spans (or reused) means the client edited a
    // stale row list — realigning on it would scramble every translation, so
    // reject and let the operator reload rather than guess.
    if (!Number.isInteger(from) || from < 0 || from >= jaLen) {
      return json({ error: `span 'from' out of range: ${from}` }, 400);
    }
    if (seen.has(from)) {
      return json({ error: `span 'from' used twice: ${from}` }, 400);
    }
    seen.add(from);
  }

  const normalized: ImageSpanEdit[] = (spans as ImageSpanEdit[]).map((s) => ({
    text: s.text,
    from: s.from ?? null,
  }));
  await restructureImageTexts(db, id, normalized);

  return json({ success: true, id, spans: normalized.length });
};
