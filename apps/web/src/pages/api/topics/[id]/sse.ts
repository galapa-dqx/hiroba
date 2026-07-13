/**
 * SSE endpoint for topics workflow progress — proxies the workflow worker's domain SSE route.
 */

import type { APIRoute } from 'astro';

import { proxyWorkflowSse } from '../../../../lib/workflow';

export const GET: APIRoute = ({ locals, params, url }) =>
  proxyWorkflowSse(
    locals.runtime,
    'topic',
    params.id!,
    url.searchParams.get('language') ?? undefined,
  );
