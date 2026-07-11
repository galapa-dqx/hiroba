/**
 * SSE endpoint for a playguide's pipeline progress. The DO is namespaced
 * `playguide:` so it doesn't collide with a news/topic DO of the same id
 * (proxies the DO).
 */

import type { APIRoute } from 'astro';

import { proxyDoSse } from '../../../../lib/sse';

export const GET: APIRoute = ({ locals, params }) => {
  const runtime = locals.runtime as {
    env: { WORKFLOW_MANAGER: DurableObjectNamespace };
  };
  const slug = params.slug!;
  return proxyDoSse(
    runtime.env,
    `playguide:${slug}`,
    `/sse?itemId=${slug}&itemType=playguide`,
  );
};
