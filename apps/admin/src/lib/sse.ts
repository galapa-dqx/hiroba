/**
 * Shared SSE proxy for the admin API — fronts the FlowHub's per-run snapshot
 * stream: hand off the query and re-emit the event stream with SSE headers.
 */

import { env } from 'cloudflare:workers';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

/**
 * Proxy the FlowHub's per-run snapshot stream (DQX-19). The hub is one
 * well-known instance; the run is addressed by the query string (`?runId=…`
 * or `?flow=…&key=…`), passed through untouched.
 */
export async function proxyHubSse(search: string): Promise<Response> {
  const stub = env.FLOW_HUB.get(env.FLOW_HUB.idFromName('hub'));
  const res = await stub.fetch(`http://internal/sse${search}`);
  return new Response(res.body, { status: res.status, headers: SSE_HEADERS });
}
