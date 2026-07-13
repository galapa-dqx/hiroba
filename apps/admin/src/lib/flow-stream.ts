/**
 * Admin-side consumers for hub flow-run SSE streams. The transport lifecycle
 * (reconnects, silence watchdog, seq dedup, run hopping) lives in
 * @hiroba/flow/client's `followRun`; this module binds it to the admin's
 * proxy route and folds terminal frames into the shapes the panels want:
 *
 *   - `subscribeFlowRun` — one known run by id (fire-and-follow UI like the
 *     scrape backfill button). `onError` means the RUN failed; transport
 *     trouble surfaces only after every retry yields nothing.
 *   - `subscribeItemRun` — an article/playguide pipeline by item identity
 *     (the list pages' per-item trigger buttons), addressed by the flow's
 *     dedup key so no run id is needed, with the item settled policy
 *     (degraded images still count as done) applied to the terminal frame.
 */

import type { Snapshot } from '@hiroba/flow';
import { followRun } from '@hiroba/flow/client';
import {
  describeItemRun,
  itemFlowKey,
  itemRunHealth,
  type ItemFlowType,
} from '@hiroba/flows';

export type FlowRunHandlers = {
  /** A fresh snapshot of a still-active run. */
  onSnapshot: (snapshot: Snapshot) => void;
  /** Terminal success, with the run's output (the flow body's return value). */
  onDone?: (output: unknown) => void;
  /** The run failed (a `failed` frame), or the stream stayed unreachable
   *  across every retry (e.g. the run was pruned). */
  onError?: (message: string) => void;
};

/**
 * Follow one run's snapshot stream and dispatch its lifecycle to `handlers`.
 * Returns a cleanup that closes the stream; it also closes itself on any
 * terminal frame.
 */
export function subscribeFlowRun(
  runId: string,
  handlers: FlowRunHandlers,
): () => void {
  return followRun(`/api/flow-runs/stream?runId=${encodeURIComponent(runId)}`, {
    onSnapshot: handlers.onSnapshot,
    onSettled: (snapshot) => {
      if (snapshot.status === 'complete') handlers.onDone?.(snapshot.output);
      else handlers.onError?.(snapshot.error ?? 'flow failed');
    },
    onUnavailable: () => handlers.onError?.('Progress stream unavailable'),
  });
}

export type ItemRunHandlers = {
  /** The "latest step" progress line for the item's live run. */
  onProgress: (label: string) => void;
  /** The run settled with displayable content (degraded images included). */
  onDone?: () => void;
  /** The run settled as a dead end, or the stream stayed unreachable. */
  onError?: (message: string) => void;
};

/**
 * Follow an item pipeline's latest run by (flow, key) — the trigger that
 * started it races this subscribe, so the 404 window is widened rather than
 * treated as unavailability.
 */
export function subscribeItemRun(
  itemType: ItemFlowType,
  itemId: string,
  handlers: ItemRunHandlers,
): () => void {
  const { flow, key } = itemFlowKey(itemType, itemId);
  return followRun(
    `/api/flow-runs/stream?flow=${encodeURIComponent(flow)}&key=${encodeURIComponent(key)}`,
    {
      onSnapshot: (snapshot) => handlers.onProgress(describeItemRun(snapshot)),
      onSettled: (snapshot) => {
        const health = itemRunHealth(snapshot);
        if (health === 'complete' || health === 'degraded') handlers.onDone?.();
        else if (health === 'fetch-failed')
          handlers.onError?.('body fetch found no content');
        else handlers.onError?.(snapshot.error ?? 'run failed');
      },
      onUnavailable: () => handlers.onError?.('Progress stream unavailable'),
    },
    { maxFramelessConnects: 10 },
  );
}
