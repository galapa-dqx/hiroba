/**
 * Client-side consumer for one hub flow run's SSE stream (DQX-23).
 *
 * The hub's per-run stream speaks full `Snapshot` frames (seq-ordered, closed
 * server-side after the terminal frame) — a different wire protocol from the
 * WorkflowManager `SSEEvent` streams job-stream.ts consumes. This is the one
 * place that folds those frames into a progress/done/error lifecycle for
 * fire-and-follow UI (e.g. the scrape backfill button); the FlowRuns panel
 * keeps its own consumer because it merges SSE with polling across many runs.
 */

import type { Snapshot } from '@hiroba/flow';

export type FlowRunHandlers = {
  /** A fresh snapshot of a still-active run. */
  onSnapshot: (snapshot: Snapshot) => void;
  /** Terminal success, with the run's output (the flow body's return value). */
  onDone?: (output: unknown) => void;
  /** Terminal failure (a `failed` frame or a dropped connection). */
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
  const source = new EventSource(
    `/api/flow-runs/stream?runId=${encodeURIComponent(runId)}`,
  );
  let settled = false;
  let lastSeq = -1;
  const close = () => source.close();

  source.onmessage = (event) => {
    const snapshot = JSON.parse(event.data as string) as Snapshot;
    // seq is monotonic per run — drop reordered/duplicate frames.
    if (snapshot.seq <= lastSeq) return;
    lastSeq = snapshot.seq;

    if (snapshot.status === 'complete') {
      settled = true;
      close();
      handlers.onDone?.(snapshot.output);
      return;
    }
    if (snapshot.status === 'failed') {
      settled = true;
      close();
      handlers.onError?.(snapshot.error ?? 'flow failed');
      return;
    }
    handlers.onSnapshot(snapshot);
  };
  // The hub closes the stream server-side after the terminal frame, which
  // lands here as an error event — only a drop BEFORE settling is a failure.
  source.onerror = () => {
    close();
    if (!settled) {
      settled = true;
      handlers.onError?.('Connection lost');
    }
  };

  return close;
}
