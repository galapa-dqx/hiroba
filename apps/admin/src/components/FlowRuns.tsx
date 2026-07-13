/**
 * "Flow runs" panel — the flow-framework side of the workflow tracker
 * (DQX-19). Lists hub runs (poll) and paints each active run's segment strip
 * live from the hub's per-run SSE snapshots. Generic by construction: it
 * renders whatever the flow definition declares (order + steps), so every
 * ported workflow (DQX-20+) appears here with zero panel changes.
 *
 * Coexists with the legacy WorkflowRuns tracker during the migration; the
 * legacy panel is deleted with WorkflowManager (DQX-26).
 */

import { useEffect, useRef, useState } from 'react';

import {
  isActiveRunStatus as isActive,
  renderCount,
  segmentView,
  type Snapshot,
  type StepState,
} from '@hiroba/flow';
// Type-only: the /hub entry's runtime half imports cloudflare:workers, which
// must never reach the client bundle. The terminality predicate itself lives
// in the platform-free core for exactly this reason.
import type { HubRunStatus, RunInfo } from '@hiroba/flow/hub';
import { formatRelativePast } from '@hiroba/ui/format-date';

const POLL_MS = 5000;

function SegmentGlyph({ view, spin }: { view: string; spin: boolean }) {
  if (spin) return <span className="wf-spinner" aria-label="in progress" />;
  const glyph =
    {
      complete: '✓',
      failed: '✕',
      skipped: '↷',
      interrupted: '△',
      'not-reached': '·',
      pending: '·',
      running: '·',
    }[view] ?? '·';
  return (
    <span className="wf-glyph" aria-hidden="true">
      {glyph}
    </span>
  );
}

function SegmentStrip({
  snapshot,
  runStatus,
}: {
  snapshot: Snapshot;
  /** The polled RunInfo status — authoritative over the snapshot's own copy,
   *  which can go stale if the SSE dropped before the terminal frame. */
  runStatus: HubRunStatus;
}) {
  const settled = !isActive(runStatus);
  const dead = runStatus === 'failed' || snapshot.status === 'failed';
  // "This run is dead" keys off run status, never off a red segment — a step
  // can flap failed → running across engine retries while the run is fine.
  // When the run settled without any step stored failed (reconciler verdict,
  // or the last frames never arrived), the step still marked running is where
  // it died — use it as the boundary so trailing steps read not-reached.
  const failedStep = snapshot.order.findIndex(
    (key) => snapshot.steps[key].state === 'failed',
  );
  const failedIndex = dead
    ? failedStep >= 0
      ? failedStep
      : snapshot.order.findIndex(
          (key) => snapshot.steps[key].state === 'running',
        )
    : -1;
  return (
    <ol className="wf-stages">
      {snapshot.order.map((key, i) => {
        const step: StepState = snapshot.steps[key];
        const stored = segmentView(step, i, failedIndex);
        // View-derived, like not-reached: a segment stored `running` on a
        // settled run isn't running anything — the run ended mid-step.
        const view = stored === 'running' && settled ? 'interrupted' : stored;
        const count = renderCount(step);
        const spin = view === 'running' && isActive(runStatus);
        return (
          <li
            key={key}
            className={`wf-stage is-${view}${spin ? ' is-active' : ''}`}
          >
            <SegmentGlyph view={view} spin={spin} />
            <span>
              {key}
              {count ? ` ${count}` : ''}
              {step.attempt > 1 ? (
                <span className="wf-retry" title={`attempt ${step.attempt}`}>
                  {' '}
                  ×{step.attempt}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function FlowRunCard({ run, snapshot }: { run: RunInfo; snapshot?: Snapshot }) {
  const active = isActive(run.status);
  return (
    <article className={`wf-run${active ? '' : ' wf-run--settled'}`}>
      <header className="wf-run__head">
        <span className="wf-run__type">{run.flow}</span>
        <span className="wf-run__title">{run.key}</span>
        <span className="wf-run__started">
          started {formatRelativePast(run.createdAt)}
        </span>
      </header>
      <div className="wf-run__summary">
        <span>
          Status:{' '}
          <strong className={`wf-status--${run.status}`}>{run.status}</strong>
        </span>
        <span className="wf-run__started">
          updated {formatRelativePast(run.updatedAt)}
        </span>
      </div>
      {snapshot && <SegmentStrip snapshot={snapshot} runStatus={run.status} />}
      {run.error && <p className="wf-run__error">{run.error}</p>}
    </article>
  );
}

/** One /runs listing entry: the run row plus its current snapshot, so the
 *  poll alone paints full segment strips (settled runs included). */
type RunListEntry = RunInfo & { snapshot: Snapshot | null };

export default function FlowRuns() {
  const [runs, setRuns] = useState<RunInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({});
  const sources = useRef(new Map<string, EventSource>());

  /** Keep the freshest frame per run — seq is monotonic, so a poll result
   *  never regresses a newer SSE frame (and vice versa). */
  const mergeSnapshot = (snap: Snapshot): void => {
    setSnapshots((prev) => {
      const current = prev[snap.runId];
      if (current && current.seq >= snap.seq) return prev;
      return { ...prev, [snap.runId]: snap };
    });
  };

  // Poll the run list — each entry embeds its snapshot, so this is a complete
  // paint on its own; SSE below only makes active runs live between polls.
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/flow-runs');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { runs: RunListEntry[] };
        if (!cancelled) {
          setRuns(data.runs);
          for (const run of data.runs) {
            if (run.snapshot) mergeSnapshot(run.snapshot);
          }
          setError(null);
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) setError('Failed to load flow runs.');
      }
    }

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // One EventSource per ACTIVE run. The hub pushes the full snapshot on
  // connect and every report after, then closes the stream itself when the
  // run settles — the terminal frame stays in state so the bar stays painted.
  useEffect(() => {
    if (!runs) return;
    const open = sources.current;
    const activeIds = new Set(
      runs.filter((r) => isActive(r.status)).map((r) => r.runId),
    );

    for (const run of runs) {
      if (!activeIds.has(run.runId) || open.has(run.runId)) continue;
      const source = new EventSource(
        `/api/flow-runs/stream?runId=${encodeURIComponent(run.runId)}`,
      );
      source.onmessage = (event) => {
        mergeSnapshot(JSON.parse(event.data as string) as Snapshot);
      };
      // Terminal close and transport error look the same here; either way we
      // stop streaming and let the poll carry the status from now on.
      source.onerror = () => {
        source.close();
        open.delete(run.runId);
      };
      open.set(run.runId, source);
    }

    // A run that settled keeps its stream: the hub sends the terminal frame
    // and closes server-side, which lands here as onerror — closing on the
    // poll's say-so instead could drop a terminal frame still in flight.
    // Reap only streams whose run left the listing entirely (pruned).
    const listed = new Set(runs.map((r) => r.runId));
    for (const [runId, source] of open) {
      if (!listed.has(runId)) {
        source.close();
        open.delete(runId);
      }
    }
  }, [runs]);

  // Close every stream on unmount.
  useEffect(() => {
    const open = sources.current;
    return () => {
      for (const source of open.values()) source.close();
      open.clear();
    };
  }, []);

  const activeCount = runs?.filter((r) => isActive(r.status)).length ?? 0;

  return (
    <div className="flow-runs">
      <p className="page-description">
        Runs on the unified flow framework (hub-tracked, live via SSE). Flows
        appear here as workflows are ported onto the hub.
      </p>

      {error && <p className="error-state">{error}</p>}

      {runs === null ? (
        <p className="loading">Loading…</p>
      ) : runs.length === 0 ? (
        <div className="empty-state">
          <p>No flow runs yet.</p>
          <p className="hint">
            The hub is mounted and waiting — the first ported workflow will show
            up here the moment it runs.
          </p>
        </div>
      ) : (
        <>
          <p className="hint">
            {activeCount} active · {runs.length - activeCount} settled
          </p>
          {runs.map((run) => (
            <FlowRunCard
              key={run.runId}
              run={run}
              snapshot={snapshots[run.runId]}
            />
          ))}
        </>
      )}
    </div>
  );
}
