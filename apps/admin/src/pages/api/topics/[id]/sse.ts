/**
 * SSE endpoint for a topic's pipeline progress. The DO is namespaced `topic:`
 * so it doesn't collide with the news DO of the same id (proxies the DO).
 */

import type { APIRoute } from 'astro';

import { proxyDoSse } from '../../../../lib/sse';

export const GET: APIRoute = ({ locals, params }) => {
  const runtime = locals.runtime as {
    env: { WORKFLOW_MANAGER: DurableObjectNamespace };
  };
  const id = params.id!;
  return proxyDoSse(
    runtime.env,
    `topic:${id}`,
    `/sse?itemId=${id}&itemType=topic`,
  );
};
