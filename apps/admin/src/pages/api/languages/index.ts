/**
 * Language whitelist API — GET the full list, POST to add (or overwrite) a
 * language. Per-code updates and deletes live in ./[code].ts.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb, listLanguages, upsertLanguage } from '@hiroba/db';

/** BCP-47-ish shape we accept as a code (it becomes a URL path prefix). */
const CODE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async () => {
  const db = createDb(env.DB);

  const languages = await listLanguages(db);
  return json({
    languages: languages.map((l) => ({
      ...l,
      updatedAt: l.updatedAt.toString(),
    })),
  });
};

export const POST: APIRoute = async ({ request }) => {
  const db = createDb(env.DB);

  const body = (await request.json()) as {
    code?: unknown;
    label?: unknown;
    nativeLabel?: unknown;
    enabled?: unknown;
  };

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const nativeLabel =
    typeof body.nativeLabel === 'string' ? body.nativeLabel.trim() : '';

  if (!CODE_PATTERN.test(code)) {
    return json({ error: 'code must look like "en", "fr" or "zh-TW"' }, 400);
  }
  if (!label || !nativeLabel) {
    return json({ error: 'label and nativeLabel are required' }, 400);
  }

  await upsertLanguage(db, {
    code,
    label,
    nativeLabel,
    enabled: body.enabled !== false,
  });
  return json({ success: true, code });
};
