/**
 * Glossary "regenerate affected texts" API — POST { sourceText } to find every
 * fetched article whose Japanese body contains the term and re-run its workflow.
 * Use after fixing an override so existing translations pick up the new term.
 */

import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { regenerateArticlesForSource } from '../../../lib/regenerate-affected';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as {
    env: { DB: D1Database; WORKFLOW_MANAGER: DurableObjectNamespace };
  };

  let body: { sourceText?: unknown };
  try {
    body = (await request.json()) as { sourceText?: unknown };
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const sourceText =
    typeof body.sourceText === 'string' ? body.sourceText.trim() : '';
  if (!sourceText) {
    return json({ error: 'sourceText is required' }, 400);
  }

  const result = await regenerateArticlesForSource(
    createDb(runtime.env.DB),
    runtime.env.WORKFLOW_MANAGER,
    sourceText,
  );

  return json({ success: true, ...result });
};
