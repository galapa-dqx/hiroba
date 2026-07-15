/**
 * Kick off the rotation-banner refresh (DQX-20: BannerFlow on the flow
 * framework). Starts via the FlowHub (see lib/start-flow.ts) — the hub
 * dedupes on the flow's constant key, so a refresh already in flight is
 * attached to, never doubled.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import type { StartResult } from '@hiroba/flow/hub';
import { BannerFlow } from '@hiroba/flows';

import { startErrorMessage, startFlowViaHub } from '../../../lib/start-flow';

export const POST: APIRoute = async () => {
  let result: StartResult;
  try {
    result = await startFlowViaHub(env.FLOW_HUB, BannerFlow.name, {});
  } catch (err) {
    return Response.json(
      { error: `Failed to start banner refresh: ${startErrorMessage(err)}` },
      { status: 502 },
    );
  }
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
