/**
 * Images API — the stored-image corpus for the admin Images screen, paired
 * with the localization state for one target language. GET only; images are
 * produced by the pipeline, never edited here.
 *
 *   GET /api/images?lang=fr&limit=30&cursor=<id>
 *
 * `lang` is the primary translation target (defaults to the first enabled
 * language). Each row carries the source transcription plus, for that language,
 * the translated spans and the localized-image R2 key so the client can render
 * the source and its translated equivalent side-by-side. In-progress rows come
 * back with their step states so the UI can show where localization is.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb, getEnabledLanguages, listImagesForAdmin } from '@hiroba/db';
import { hasJapanese } from '@hiroba/shared';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Parse a JSON string-array value, tolerating malformed/absent input. */
function parseSpans(value: string | null | undefined): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ url }) => {
  const db = createDb(env.DB);

  const enabled = await getEnabledLanguages(db);
  const requested = url.searchParams.get('lang');
  // Honour the requested language when it's one we translate into; otherwise
  // fall back to the first enabled language so the screen always shows a target.
  const language =
    requested && enabled.some((l) => l.code === requested)
      ? requested
      : enabled[0].code;

  // Note: an absent param reads as null, and Number(null) is 0 — so guard on the
  // raw string before converting, or "no cursor" would become cursor 0.
  const limitRaw = url.searchParams.get('limit');
  const limitParam = limitRaw ? Number(limitRaw) : NaN;
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 30;
  const cursorRaw = url.searchParams.get('cursor');
  const cursorParam = cursorRaw ? Number(cursorRaw) : NaN;
  const cursor = Number.isFinite(cursorParam) ? cursorParam : undefined;

  // Filters applied server-side so pagination walks the matching set, not every
  // image. `source` is validated against the known set; anything else = no filter.
  const onlyText = url.searchParams.get('onlyText') === 'true';
  const source =
    url.searchParams.get('source') === 'banner' ? 'banner' : undefined;

  const { rows, hasMore, nextCursor } = await listImagesForAdmin(db, {
    language,
    limit,
    cursor,
    onlyText,
    source,
  });

  const items = rows.map(({ image, text, localized, isBanner }) => {
    // textsJa is a json<string[]> column — already parsed on read. The `text`
    // translation, by contrast, is a plain TEXT column holding a JSON array.
    const textsJa = image.textsJa ?? null;
    return {
      id: image.id,
      key: image.key,
      textsJa,
      hasText: !!textsJa && hasJapanese(textsJa),
      isBanner,
      mirrorState: image.mirrorState,
      transcribeState: image.transcribeState,
      updatedAt: image.updatedAt.toString(),
      translation: {
        textState: text?.state ?? null,
        texts: parseSpans(text?.value),
        // The localized image is now a render — its existence IS the "done"
        // signal; in-flight/failure lives on the flow run, not a state column.
        urlState: localized ? 'done' : null,
        localizedKey: localized?.key ?? null,
        error: text?.error ?? null,
        translatedAt:
          (localized?.createdAt ?? text?.translatedAt)?.toString() ?? null,
      },
    };
  });

  return json({ language, items, hasMore, nextCursor });
};
