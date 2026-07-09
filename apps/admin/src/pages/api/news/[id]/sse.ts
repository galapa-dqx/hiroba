/** SSE endpoint for a news item's pipeline progress (proxies the DO). */

import type { APIRoute } from 'astro';

import { proxyDoSse } from '../../../../lib/sse';

export const GET: APIRoute = ({ locals, params }) => {
  const runtime = locals.runtime as {
    env: { WORKFLOW_MANAGER: DurableObjectNamespace };
  };
  const id = params.id!;
  return proxyDoSse(runtime.env, id, `/sse?itemId=${id}&itemType=news`);
};
