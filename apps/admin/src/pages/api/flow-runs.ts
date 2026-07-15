/**
 * Lists recent flow-framework runs for the workflow tracker.
 *
 * Proxies the workflow worker's /flow/runs route (DQX-26), which merges the
 * hub's run listing (each entry with its current segment snapshot) with
 * per-item domain enrichment — titles, D1 pipeline snapshot, image detail —
 * for the article/playguide flows.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ url }) => {
  // ?flow=…&limit=… pass through untouched.
  const res = await env.WORKFLOW.fetch(
    `http://internal/flow/runs${url.search}`,
  );

  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
