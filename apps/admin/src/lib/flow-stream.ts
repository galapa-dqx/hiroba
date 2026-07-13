/**
 * Client-side consumer for one hub flow run's SSE stream (DQX-23).
 *
 * The hub's per-run stream speaks full `Snapshot` frames (seq-ordered, closed
 * server-side after the terminal frame) — a different wire protocol from the
 * domain `SSEEvent` streams job-stream.ts consumes. This is the one
 * place that folds those frames into a progress/done/error lifecycle for
 * fire-and-follow UI (e.g. the scrape backfill button); the FlowRuns panel
 * keeps its own consumer because it merges SSE with polling across many runs.
 *
 * Built for lossless resume, so it never gives up on a transport blip: every
 * (re)connect replays the run's full latest snapshot, connecting runs the
 * hub's lazy reconciler, and `seq` dedups replays. A dropped connection
 * reopens with a delay; a stream that goes silent too long is proactively
 * reopened (the reconnect doubles as the liveness probe — a run whose
 * terminal report was lost is settled by the reconciler and the fresh
 * connect delivers the terminal frame instead of leaving the caller hanging
 * forever). `onError` therefore means the RUN failed — transport trouble is
 * only surfaced after several consecutive connects yield no frame at all
 * (e.g. the run was pruned).
 */

import { isTerminalRunStatus, type Snapshot } from '@hiroba/flow';

/** Reopen a stream that has said nothing for this long — liveness probe. */
const SILENCE_REOPEN_MS = 30_000;
/** Delay before reopening after a hard transport close. */
const RECONNECT_DELAY_MS = 5_000;
/** Consecutive frameless connects before declaring the stream unavailable. */
const MAX_FRAMELESS_CONNECTS = 5;

export type FlowRunHandlers = {
  /** A fresh snapshot of a still-active run. */
  onSnapshot: (snapshot: Snapshot) => void;
  /** Terminal success, with the run's output (the flow body's return value). */
  onDone?: (output: unknown) => void;
  /** The run failed (a `failed` frame), or the stream stayed unreachable
   *  across every retry. */
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
  let stopped = false;
  let lastSeq = -1;
  let framelessConnects = 0;
  let gotFrameThisConnect = false;
  let source: EventSource | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    stopped = true;
    if (silenceTimer !== null) clearTimeout(silenceTimer);
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    source?.close();
    source = null;
  };

  const scheduleReopen = (delayMs: number) => {
    if (stopped || reconnectTimer !== null) return;
    if (silenceTimer !== null) clearTimeout(silenceTimer);
    source?.close();
    source = null;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delayMs);
  };

  const armSilenceWatchdog = () => {
    if (silenceTimer !== null) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => scheduleReopen(0), SILENCE_REOPEN_MS);
  };

  const open = () => {
    if (stopped) return;
    gotFrameThisConnect = false;
    source = new EventSource(
      `/api/flow-runs/stream?runId=${encodeURIComponent(runId)}`,
    );
    armSilenceWatchdog();

    source.onmessage = (event) => {
      gotFrameThisConnect = true;
      framelessConnects = 0;
      armSilenceWatchdog();
      const snapshot = JSON.parse(event.data as string) as Snapshot;
      // seq is monotonic per run — drop reconnect replays and stale frames.
      if (snapshot.seq <= lastSeq) return;
      lastSeq = snapshot.seq;

      if (isTerminalRunStatus(snapshot.status)) {
        stop();
        if (snapshot.status === 'complete') handlers.onDone?.(snapshot.output);
        else handlers.onError?.(snapshot.error ?? 'flow failed');
        return;
      }
      handlers.onSnapshot(snapshot);
    };

    // EventSource retries CONNECTING states on its own; a CLOSED readyState
    // is a hard stop (the hub 404ing a pruned run, a proxy refusing the
    // route). Reopen ourselves with a delay — unless connect after connect
    // yields nothing, which means the run is not streamable at all.
    source.onerror = () => {
      if (stopped || source?.readyState !== EventSource.CLOSED) return;
      if (!gotFrameThisConnect) {
        framelessConnects += 1;
        if (framelessConnects >= MAX_FRAMELESS_CONNECTS) {
          stop();
          handlers.onError?.('Progress stream unavailable');
          return;
        }
      }
      scheduleReopen(RECONNECT_DELAY_MS);
    };
  };

  open();
  return stop;
}
