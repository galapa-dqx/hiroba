/**
 * Start a flow through the FlowHub's fetch surface — the one home for the
 * stub-lookup → POST `/start` → `StartResult` parse that every trigger route
 * was copying (and letting drift). Fetch rather than RPC: cross-script DO RPC
 * is unsupported between local dev sessions. Response shaping stays at the
 * call sites.
 *
 * Throws on a non-OK response carrying the hub's own error body — the hub
 * deliberately ships the real failure reason ("Errors surface as a 500 with
 * the message"), so routes can put it in front of the operator.
 */

import type { StartOptions, StartResult } from '@hiroba/flow/hub';

export async function startFlowViaHub(
  namespace: DurableObjectNamespace,
  flow: string,
  params: unknown,
  opts: StartOptions = {},
): Promise<StartResult> {
  const stub = namespace.get(namespace.idFromName('hub'));
  const res = await stub.fetch('http://internal/start', {
    method: 'POST',
    body: JSON.stringify({ flow, params, ...opts }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `hub start "${flow}" failed: ${res.status}${detail ? ` ${detail}` : ''}`,
    );
  }
  return (await res.json()) as StartResult;
}

/** Error → operator-facing string, for routes surfacing a failed start. */
export function startErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
