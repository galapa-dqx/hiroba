/**
 * Client-side (re)trigger for an item's pipeline — the processing callout's
 * self-heal (DQX-28). The page render fires the initial trigger, but that
 * call is fire-and-forget from SSR and can be lost; while the callout waits
 * out a stale terminal run it re-arms through this route instead of spinning
 * forever on old news.
 *
 * Same shape as the SSR trigger: `force` past the settled-run cooldown (a
 * viewer is actively waiting) and `probe` a stale-looking active run. The
 * hub still dedups — an active run is attached to, never doubled — so the
 * worst a hammering client achieves is what one page view already could.
 */

import type { APIRoute } from 'astro';

import { itemFlowStart } from '@hiroba/flows';

const ITEM_TYPES = new Set(['news', 'topic', 'playguide']);

export const POST: APIRoute = async ({ locals, request }) => {
  let body: { itemType?: string; itemId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response('invalid JSON body', { status: 400 });
  }
  const { itemType, itemId } = body;
  if (
    !itemType ||
    !ITEM_TYPES.has(itemType) ||
    !itemId ||
    itemId.length > 200
  ) {
    return new Response('unknown item', { status: 404 });
  }

  const start = itemFlowStart(
    itemType as 'news' | 'topic' | 'playguide',
    itemId,
  );
  const ns = locals.runtime.env.FLOW_HUB;
  const stub = ns.get(ns.idFromName('hub'));
  const res = await stub.fetch('http://internal/start', {
    method: 'POST',
    body: JSON.stringify({ ...start, force: true, probe: true }),
    headers: { 'Content-Type': 'application/json' },
  });
  return res.ok
    ? new Response(null, { status: 202 })
    : new Response('trigger failed', { status: 502 });
};
