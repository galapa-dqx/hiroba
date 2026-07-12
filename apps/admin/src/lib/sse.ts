/**
 * Shared SSE proxy for the admin API. Every admin stream endpoint fronts a
 * WorkflowManager DO instance: name the instance, hand off an internal path,
 * and re-emit the DO's event stream with SSE headers. One helper for the
 * per-article pipeline streams and the whole-archive scrape stream alike.
 */

type SseEnv = { WORKFLOW_MANAGER: DurableObjectNamespace };

/**
 * The WorkflowManager DO instance name for a whole-archive news scrape. Shared
 * by the trigger route (POST /api/scrape) and the progress stream
 * (GET /api/scrape/stream) so both address the same instance.
 */
export const newsScrapeStreamKey = (category?: string): string =>
  `scrape:news:${category ?? 'all'}`;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

/**
 * Proxy an SSE stream from the WorkflowManager DO instance `doName`, calling its
 * internal `path` (e.g. `/sse?itemId=…&itemType=news` or `/scrape-sse`).
 */
export async function proxyDoSse(
  env: SseEnv,
  doName: string,
  path: string,
): Promise<Response> {
  const stub = env.WORKFLOW_MANAGER.get(
    env.WORKFLOW_MANAGER.idFromName(doName),
  );
  const res = await stub.fetch(`http://internal${path}`);
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
