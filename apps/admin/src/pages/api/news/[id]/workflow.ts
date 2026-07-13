/**
 * Re-run one news item's pipeline (DQX-25: ArticleFlow on the flow framework).
 * Starts via the FlowHub — keyed `news:<id>`, so a run already in flight is
 * attached to, never doubled. `force` skips the page-view cooldown (this is an
 * operator action) and `probe` verifies a stale-looking active run against the
 * engine before attaching, since the operator is watching.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import type { StartResult } from '@hiroba/flow/hub';
import { ArticleFlow } from '@hiroba/flows';

import { startErrorMessage, startFlowViaHub } from '../../../../lib/start-flow';

export const POST: APIRoute = async ({ params }) => {
  const id = params.id!;
  let result: StartResult;
  try {
    result = await startFlowViaHub(
      env.FLOW_HUB,
      ArticleFlow.name,
      { itemId: id, itemType: 'news' },
      { force: true, probe: true },
    );
  } catch (err) {
    return Response.json(
      { error: `Failed to start workflow: ${startErrorMessage(err)}` },
      { status: 502 },
    );
  }
  if (result.throttled) {
    // Unreachable under force, but the wire type carries it.
    return Response.json({ status: 'throttled' });
  }
  return Response.json({
    status: result.created ? 'started' : 'already_running',
    instanceId: result.runId,
  });
};
