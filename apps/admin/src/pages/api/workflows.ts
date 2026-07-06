/**
 * Lists recent workflow runs for the tracker page.
 *
 * Proxies the WorkflowManager DO's /runs endpoint. That endpoint reads only
 * global state (the workflow_runs registry + the Workflows engine), so any
 * instance can serve it — we address a well-known 'registry' instance instead
 * of an item-scoped one.
 */

import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime as {
    env: { WORKFLOW_MANAGER: DurableObjectNamespace };
  };

  const doId = runtime.env.WORKFLOW_MANAGER.idFromName('registry');
  const stub = runtime.env.WORKFLOW_MANAGER.get(doId);

  const res = await stub.fetch('http://internal/runs');

  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
