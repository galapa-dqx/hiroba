/**
 * Lists recent flow-framework runs for the "Flow runs" panel (DQX-19).
 *
 * Proxies the FlowHub DO's /runs route on its single well-known 'hub'
 * instance — the hub serves the listing as a local SELECT (plus its lazy
 * reconcile of any active row whose producer went silent). Fetch rather than
 * RPC: cross-script DO RPC is unsupported between local dev sessions.
 */

import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals, url }) => {
  const ns = locals.runtime.env.FLOW_HUB;
  const stub = ns.get(ns.idFromName('hub'));

  // ?flow=…&limit=… pass through untouched.
  const res = await stub.fetch(`http://internal/runs${url.search}`);

  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
