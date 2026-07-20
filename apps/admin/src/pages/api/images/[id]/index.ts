/**
 * Single-image detail for the admin image-edit screen. Unlike the list
 * (`/api/images`), this returns the image's localization state for *every*
 * enabled language at once, so the editor can offer a tab per language:
 *
 *   GET /api/images/<id>
 *
 * Each language carries its translated spans (index-aligned to `texts_ja`),
 * the localized-image R2 key + its producing model (so the UI can tell a
 * hand-supplied override from a pipeline render), and the current step states.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb, getEnabledLanguages } from '@hiroba/db';
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

export const GET: APIRoute = async ({ params }) => {
  const db = createDb(env.DB);

  const id = Number(params.id);
  if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);

  const image = await db.query.images.findFirst({ where: { id } });
  if (!image) return json({ error: 'Not found' }, 404);

  const enabled = await getEnabledLanguages(db);
  // Every translation row for this image across all languages and both fields
  // (`text`/`url`) — one read renders each language tab's spans + image state.
  const rows = await db.query.translations.findMany({
    where: { itemType: 'image', itemId: String(id) },
  });
  const textByLang = new Map<string, (typeof rows)[number]>();
  const urlByLang = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    (r.field === 'url' ? urlByLang : textByLang).set(r.language, r);
  }

  const textsJa = image.textsJa ?? null;
  const translations = Object.fromEntries(
    enabled.map((l) => {
      const text = textByLang.get(l.code) ?? null;
      const urlRow = urlByLang.get(l.code) ?? null;
      return [
        l.code,
        {
          textState: text?.state ?? null,
          texts: parseSpans(text?.value),
          urlState: urlRow?.state ?? null,
          localizedKey: urlRow?.value ?? null,
          urlModel: urlRow?.model ?? null,
          error: urlRow?.error ?? text?.error ?? null,
          translatedAt:
            (urlRow?.translatedAt ?? text?.translatedAt)?.toString() ?? null,
        },
      ];
    }),
  );

  return json({
    id: image.id,
    key: image.key,
    textsJa,
    hasText: !!textsJa && hasJapanese(textsJa),
    mirrorState: image.mirrorState,
    transcribeState: image.transcribeState,
    updatedAt: image.updatedAt.toString(),
    languages: enabled.map((l) => ({
      code: l.code,
      label: l.label,
      nativeLabel: l.nativeLabel,
    })),
    translations,
  });
};
