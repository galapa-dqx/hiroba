/**
 * Shared SSE proxy for the admin API. An admin stream endpoint fronts either
 * the workflow worker's domain SSE route (per-article pipeline streams,
 * DQX-26) or the FlowHub's per-run snapshot stream: hand off an internal
 * path and re-emit the event stream with SSE headers.
 */

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

/**
 * Proxy the workflow worker's domain SSE stream over the WORKFLOW service
 * binding, calling its plain `path` (e.g. `/sse?itemId=…&itemType=news`).
 */
export async function proxyWorkflowSse(
  env: { WORKFLOW: Fetcher },
  path: string,
): Promise<Response> {
  const res = await env.WORKFLOW.fetch(`http://internal${path}`);
  return new Response(res.body, { status: res.status, headers: SSE_HEADERS });
}

/**
 * Proxy the FlowHub's per-run snapshot stream (DQX-19). The hub is one
 * well-known instance; the run is addressed by the query string (`?runId=…`
 * or `?flow=…&key=…`), passed through untouched.
 */
export async function proxyHubSse(
  env: { FLOW_HUB: DurableObjectNamespace },
  search: string,
): Promise<Response> {
  const stub = env.FLOW_HUB.get(env.FLOW_HUB.idFromName('hub'));
  const res = await stub.fetch(`http://internal/sse${search}`);
  return new Response(res.body, { status: res.status, headers: SSE_HEADERS });
}
