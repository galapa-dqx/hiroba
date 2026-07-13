/**
 * "Flow runs" panel — THE workflow tracker (DQX-26). Lists hub runs (poll)
 * and paints each active run's segment strip live from the hub's per-run SSE
 * snapshots. Generic by construction: it renders whatever the flow definition
 * declares (order + steps), so every flow appears here with zero panel
 * changes; the article/playguide runs additionally carry per-item identity
 * (the translated title) rendered by the shared FlowRunCard.
 */

import { useEffect, useRef, useState } from 'react';

import { isActiveRunStatus as isActive, type Snapshot } from '@hiroba/flow';

import { getFlowRuns, type FlowRunEntry } from '../lib/api';
import FlowRunCard from './FlowRunCard';

const POLL_MS = 5000;

export default function FlowRuns() {
  const [runs, setRuns] = useState<FlowRunEntry[] | null>(null);
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
        const data = await getFlowRuns();
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
        Live status of hub-tracked flow runs across every pipeline — refreshes
        every few seconds. Settled runs stay listed for a day.
      </p>

      {error && <p className="error-state">{error}</p>}

      {runs === null ? (
        <p className="loading">Loading…</p>
      ) : runs.length === 0 ? (
        <div className="empty-state">
          <p>No flow runs recorded recently.</p>
          <p className="hint">
            Trigger one from the News or Topics pages and it will appear here.
          </p>
        </div>
      ) : (
        <>
          <p className="hint">
            {activeCount} active · {runs.length - activeCount} recently settled
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
