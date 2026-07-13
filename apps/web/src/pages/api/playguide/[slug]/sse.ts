/**
 * SSE endpoint for playguide workflow progress — proxies the workflow worker's domain SSE route.
 */

import type { APIRoute } from 'astro';

import { proxyWorkflowSse } from '../../../../lib/workflow';

export const GET: APIRoute = ({ locals, params, url }) =>
  proxyWorkflowSse(
    locals.runtime,
    'playguide',
    params.slug!,
    url.searchParams.get('language') ?? undefined,
  );
