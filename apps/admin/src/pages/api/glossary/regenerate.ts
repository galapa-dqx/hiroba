/**
 * Glossary "regenerate affected texts" API — POST { sourceText } to re-run every
 * article whose Japanese body contains the term AND refresh the stored `text`
 * translation of every image whose baked-in Japanese contains it, so both pick
 * up an edited override. (Localized image rasters are not re-rendered — only the
 * text we store for generation is updated.) Starts GlossaryRegenFlow via the
 * FlowHub's fetch surface (DQX-21): the hub dedupes on the term key, so a
 * regeneration already in flight for the same term is attached to, never
 * doubled. The flow keyset-pages the whole affected set with no cap, so this
 * returns immediately rather than fanning out every trigger inline. Fetch
 * rather than RPC: cross-script DO RPC is unsupported between local dev
 * sessions.
 */

import type { APIRoute } from 'astro';

import type { StartResult } from '@hiroba/flow/hub';
import { GlossaryRegenFlow } from '@hiroba/flows';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ locals, request }) => {
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

  const ns = locals.runtime.env.FLOW_HUB;
  const stub = ns.get(ns.idFromName('hub'));
  const res = await stub.fetch('http://internal/start', {
    method: 'POST',
    body: JSON.stringify({
      flow: GlossaryRegenFlow.name,
      params: { sourceText },
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    return json({ error: 'Failed to start glossary regeneration' }, 502);
  }

  const result = (await res.json()) as StartResult;
  if (result.throttled) {
    // Unreachable without a cooldown, but the wire type carries it.
    return json({ status: 'throttled' });
  }
  // The client's contract predates the hub: created=false means a run for the
  // same term was already active and we attached to it.
  return json({
    status: result.created ? 'started' : 'already_running',
    instanceId: result.runId,
  });
};
