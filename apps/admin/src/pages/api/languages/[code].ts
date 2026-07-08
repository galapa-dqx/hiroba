/**
 * Per-language whitelist API — PUT to edit labels / toggle enabled, DELETE to
 * remove. Both refuse to strip the last enabled language: the public site and
 * the pipeline always need at least one target.
 */

import type { APIRoute } from 'astro';

import {
  createDb,
  deleteLanguage,
  listLanguages,
  upsertLanguage,
  type Database,
} from '@hiroba/db';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getDb(locals: App.Locals): Database {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  return createDb(runtime.env.DB);
}

/** Whether `code` is the only enabled language on the whitelist. */
async function isLastEnabled(db: Database, code: string): Promise<boolean> {
  const enabled = (await listLanguages(db)).filter((l) => l.enabled);
  return enabled.length === 1 && enabled[0].code === code;
}

export const PUT: APIRoute = async ({ locals, params, request }) => {
  const db = getDb(locals);
  const code = params.code!;

  const existing = (await listLanguages(db)).find((l) => l.code === code);
  if (!existing) return json({ error: 'Not found' }, 404);

  const body = (await request.json()) as {
    label?: unknown;
    nativeLabel?: unknown;
    enabled?: unknown;
  };

  const label =
    typeof body.label === 'string' && body.label.trim()
      ? body.label.trim()
      : existing.label;
  const nativeLabel =
    typeof body.nativeLabel === 'string' && body.nativeLabel.trim()
      ? body.nativeLabel.trim()
      : existing.nativeLabel;
  const enabled =
    typeof body.enabled === 'boolean' ? body.enabled : existing.enabled;

  if (existing.enabled && !enabled && (await isLastEnabled(db, code))) {
    return json({ error: 'At least one language must stay enabled' }, 400);
  }

  await upsertLanguage(db, { code, label, nativeLabel, enabled });
  return json({ success: true, code });
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const db = getDb(locals);
  const code = params.code!;

  if (await isLastEnabled(db, code)) {
    return json({ error: 'At least one language must stay enabled' }, 400);
  }

  const deleted = await deleteLanguage(db, code);
  if (!deleted) return json({ error: 'Not found' }, 404);
  return json({ success: true, code });
};
