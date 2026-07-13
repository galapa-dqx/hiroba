/**
 * Live progress stream for an item's pipeline run — fronts the FlowHub's SSE
 * endpoint, addressed by (flow, key) so the client needs no run id (the hub
 * resolves the latest run for the item; DQX-28). Each frame is a full
 * `Snapshot`; the hub closes the stream itself once the run settles.
 *
 * Public-facing, so the query is validated down to exactly the item
 * pipelines: run snapshots aren't sensitive (step names + counters), but the
 * generic flows (backfills, banners, glossary) are nobody's business outside
 * the admin.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { ArticleFlow, PlayguideFlow } from '@hiroba/flows';

const PUBLIC_FLOWS = new Set<string>([ArticleFlow.name, PlayguideFlow.name]);

export const GET: APIRoute = async ({ url }) => {
  const flow = url.searchParams.get('flow') ?? '';
  const key = url.searchParams.get('key') ?? '';
  if (!PUBLIC_FLOWS.has(flow) || !key) {
    return new Response('unknown stream', { status: 404 });
  }

  const ns = env.FLOW_HUB;
  const stub = ns.get(ns.idFromName('hub'));
  const res = await stub.fetch(
    `http://internal/sse?flow=${encodeURIComponent(flow)}&key=${encodeURIComponent(key)}`,
  );
  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
};
