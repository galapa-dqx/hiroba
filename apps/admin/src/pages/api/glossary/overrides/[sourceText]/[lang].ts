/**
 * Delete one admin glossary override. The upstream mirror row (if any)
 * resurfaces in the effective view afterward.
 */

import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { deleteGlossaryOverride } from '../../../../../lib/db-operations';

export const DELETE: APIRoute = async ({ locals, params }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const sourceText = decodeURIComponent(params.sourceText!);
  const lang = params.lang!;

  const success = await deleteGlossaryOverride(db, sourceText, lang);

  if (!success) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
