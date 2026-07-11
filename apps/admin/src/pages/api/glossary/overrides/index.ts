/**
 * Glossary overrides API — POST to add or edit an admin override. Unlike the
 * upstream mirror (imported nightly from GitHub), overrides survive the refresh
 * and take precedence during translation. Deletes live in ./[sourceText]/[lang].
 */

import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { upsertGlossaryOverride } from '../../../../lib/db-operations';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const body = (await request.json()) as {
    sourceText?: unknown;
    targetLanguage?: unknown;
    translatedText?: unknown;
  };

  const sourceText =
    typeof body.sourceText === 'string' ? body.sourceText.trim() : '';
  const targetLanguage =
    typeof body.targetLanguage === 'string' ? body.targetLanguage.trim() : '';
  const translatedText =
    typeof body.translatedText === 'string' ? body.translatedText.trim() : '';

  if (!sourceText || !targetLanguage || !translatedText) {
    return json(
      { error: 'sourceText, targetLanguage and translatedText are required' },
      400,
    );
  }

  await upsertGlossaryOverride(db, {
    sourceText,
    targetLanguage,
    translatedText,
  });
  return json({ success: true, sourceText, targetLanguage });
};
