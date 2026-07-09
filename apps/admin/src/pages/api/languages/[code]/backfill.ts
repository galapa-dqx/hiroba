/**
 * Pre-warm a language's title archive (DQX-13): POST kicks off the
 * whole-archive TitleBackfillWorkflow for `code` via the WorkflowManager DO,
 * so an admin can fill a language in before announcing it rather than waiting
 * for the first list view to arm it. The DO dedupes, so re-posting while a run
 * is in flight is a harmless no-op.
 */

import type { APIRoute } from 'astro';

import { createDb, listLanguages } from '@hiroba/db';

import { backfillLanguageTitles } from '../../../../lib/backfill-titles';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ locals, params }) => {
  const runtime = locals.runtime as {
    env: { DB: D1Database; WORKFLOW_MANAGER: DurableObjectNamespace };
  };
  const code = params.code!;

  // Only backfill a whitelisted language — a stray code would just spin up a
  // workflow that finds nothing.
  const known = (await listLanguages(createDb(runtime.env.DB))).some(
    (l) => l.code === code,
  );
  if (!known) return json({ error: 'Not found' }, 404);

  const started = await backfillLanguageTitles(
    runtime.env.WORKFLOW_MANAGER,
    code,
  );
  if (!started) return json({ error: 'Failed to start backfill' }, 502);
  return json({ success: true, code });
};
