/**
 * Glossary "regenerate affected texts" API — POST { sourceText } to re-run every
 * article whose Japanese body contains the term, so translations pick up an
 * edited override. Delegates to the WorkflowManager DO, which starts (and
 * dedupes per term) the durable GlossaryRegenerateWorkflow; that workflow pages
 * the whole affected set with no cap, so this returns immediately rather than
 * fanning out every trigger inline.
 */

import type { APIRoute } from 'astro';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as {
    env: { WORKFLOW_MANAGER: DurableObjectNamespace };
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

  // Dedicated DO instance per term so the manager dedupes concurrent runs.
  const doId = runtime.env.WORKFLOW_MANAGER.idFromName(
    `glossary-regenerate:${sourceText}`,
  );
  const stub = runtime.env.WORKFLOW_MANAGER.get(doId);
  const res = await stub.fetch('http://internal/regenerate-glossary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceText }),
  });

  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
