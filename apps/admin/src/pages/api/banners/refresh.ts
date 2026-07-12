/**
 * Kick off the rotation-banner refresh (DQX-20: BannerFlow on the flow
 * framework). Starts via the FlowHub's fetch surface — the hub dedupes on the
 * flow's constant key, so a refresh already in flight is attached to, never
 * doubled. Fetch rather than RPC: cross-script DO RPC is unsupported between
 * local dev sessions.
 */

import type { APIRoute } from 'astro';

import type { StartResult } from '@hiroba/flow/hub';
import { BannerFlow } from '@hiroba/flows';

export const POST: APIRoute = async ({ locals }) => {
  const ns = locals.runtime.env.FLOW_HUB;
  const stub = ns.get(ns.idFromName('hub'));

  const res = await stub.fetch('http://internal/start', {
    method: 'POST',
    body: JSON.stringify({ flow: BannerFlow.name, params: {} }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    return Response.json(
      { error: 'Failed to start banner refresh' },
      { status: 502 },
    );
  }

  const result = (await res.json()) as StartResult;
  if (result.throttled) {
    // Unreachable without a cooldown, but the wire type carries it.
    return Response.json({ status: 'throttled' });
  }
  // The dashboard's contract predates the hub: created=false means a run with
  // the same key was already active and we attached to it.
  return Response.json({
    status: result.created ? 'started' : 'already_running',
    instanceId: result.runId,
  });
};
