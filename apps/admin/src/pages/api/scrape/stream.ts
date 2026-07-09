/** SSE progress stream for the whole-archive news scrape (proxies the DO). */

import type { APIRoute } from 'astro';

import { newsScrapeStreamKey, proxyDoSse } from '../../../lib/sse';

export const GET: APIRoute = ({ locals, request }) => {
  const runtime = locals.runtime as {
    env: { WORKFLOW_MANAGER: DurableObjectNamespace };
  };
  const category =
    new URL(request.url).searchParams.get('category') ?? undefined;
  return proxyDoSse(runtime.env, newsScrapeStreamKey(category), '/scrape-sse');
};
