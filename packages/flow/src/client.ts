/**
 * Browser-side consumer for a hub flow-run SSE stream — the one place that
 * folds `Snapshot` frames into a progress/done/error lifecycle for
 * fire-and-follow UI. App code supplies the stream URL (each app fronts the
 * hub behind its own proxy route); everything transport-shaped lives here.
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
 * (e.g. the run was pruned, or no run exists yet for the flow key).
 *
 * Uses EventSource + timers only — importable from any browser bundle; keep
 * platform (cloudflare:workers) imports out.
 */

import { isTerminalRunStatus, type Snapshot } from './snapshot';

/** Reopen a stream that has said nothing for this long — liveness probe. */
const SILENCE_REOPEN_MS = 30_000;
/** Delay before reopening after a hard transport close. */
const RECONNECT_DELAY_MS = 5_000;
/** Consecutive frameless connects before declaring the stream unavailable. */
const MAX_FRAMELESS_CONNECTS = 5;

export type FollowRunHandlers = {
  /** A fresh snapshot of a still-active run. */
  onSnapshot: (snapshot: Snapshot) => void;
  /** Terminal frame — the run settled. `complete` carries the flow body's
   *  output; anything else carries the failure message. */
  onSettled?: (snapshot: Snapshot) => void;
  /** The stream stayed unreachable across every retry (the run was pruned,
   *  or none exists yet for the flow key and none appeared). */
  onUnavailable?: () => void;
};

export type FollowRunOptions = {
  /** Consecutive frameless connects tolerated before `onUnavailable` (default
   *  5). Raise it when the run may not exist yet at subscribe time (a
   *  fire-and-forget trigger racing the first connect). */
  maxFramelessConnects?: number;
  /** Delay between reconnects (default 5s). */
  reconnectDelayMs?: number;
};

/**
 * Follow one run's snapshot stream and dispatch its lifecycle to `handlers`.
 * `url` addresses an SSE route that speaks hub `Snapshot` frames (by runId or
 * flow+key — the caller's proxy decides). Returns a cleanup that closes the
 * stream; it also closes itself on any terminal frame.
 */
export function followRun(
  url: string,
  handlers: FollowRunHandlers,
  options: FollowRunOptions = {},
): () => void {
  const maxFrameless = options.maxFramelessConnects ?? MAX_FRAMELESS_CONNECTS;
  const reconnectDelay = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;

  let stopped = false;

  let lastRunId: string | null = null;
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
    source = new EventSource(url);
    armSilenceWatchdog();

    source.onmessage = (event) => {
      gotFrameThisConnect = true;
      framelessConnects = 0;
      armSilenceWatchdog();
      const snapshot = JSON.parse(event.data as string) as Snapshot;
      // seq is monotonic per run — drop reconnect replays and stale frames.
      // A flow+key subscription can hop to a NEWER run across a reconnect
      // (its seq restarts near 0), so the guard resets when the run changes.
      if (snapshot.runId !== lastRunId) {
        lastRunId = snapshot.runId;
        lastSeq = -1;
      }
      if (snapshot.seq <= lastSeq) return;
      lastSeq = snapshot.seq;

      if (isTerminalRunStatus(snapshot.status)) {
        stop();
        handlers.onSettled?.(snapshot);
        return;
      }
      handlers.onSnapshot(snapshot);
    };

    // EventSource retries CONNECTING states on its own; a CLOSED readyState
    // is a hard stop (the hub 404ing a missing run, a proxy refusing the
    // route). Reopen ourselves with a delay — unless connect after connect
    // yields nothing, which means the run is not streamable at all.
    source.onerror = () => {
      if (stopped || source?.readyState !== EventSource.CLOSED) return;
      if (!gotFrameThisConnect) {
        framelessConnects += 1;
        if (framelessConnects >= maxFrameless) {
          stop();
          handlers.onUnavailable?.();
          return;
        }
      }
      scheduleReopen(reconnectDelay);
    };
  };

  open();
  return stop;
}
