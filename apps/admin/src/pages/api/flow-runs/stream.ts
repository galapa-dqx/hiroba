/**
 * Live snapshot stream for one flow run (DQX-19) — fronts the FlowHub's SSE
 * endpoint. Each frame is a full `Snapshot` (seq-ordered); the hub closes the
 * stream itself once the run settles.
 */

import type { APIRoute } from 'astro';

import { proxyHubSse } from '../../../lib/sse';

export const GET: APIRoute = ({ url }) => proxyHubSse(url.search);
