/**
 * SSE endpoint for a topic's pipeline progress — proxies the workflow
 * worker's domain SSE route.
 */

import type { APIRoute } from 'astro';

import { proxyWorkflowSse } from '../../../../lib/sse';

export const GET: APIRoute = ({ locals, params }) => {
  const id = params.id!;
  return proxyWorkflowSse(
    locals.runtime.env,
    `/sse?itemId=${id}&itemType=topic`,
  );
};
