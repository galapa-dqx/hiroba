/**
 * Workflow tracker — live view of in-flight (and recently settled)
 * ArticleWorkflow runs. Each run renders as a RunCard (see ./RunCard).
 */

import { useEffect, useState } from 'react';

import { isRunActive, type WorkflowRunEntry } from '@hiroba/shared';

import { getWorkflowRuns } from '../lib/api';
import RunCard from './RunCard';

const POLL_MS = 2500;

export default function WorkflowRuns() {
  const [runs, setRuns] = useState<WorkflowRunEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (document.hidden) return;
      try {
        const res = await getWorkflowRuns();
        if (!cancelled) {
          setRuns(res.runs);
          setError(null);
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) setError('Failed to load workflow runs.');
      }
    }

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const activeCount = runs?.filter((r) => isRunActive(r.status)).length ?? 0;

  return (
    <div className="workflow-runs-page">
      <p className="page-description">
        Live status of article-pipeline runs — refreshes every few seconds.
        Settled runs stay listed for a day.
      </p>

      {error && <p className="error-state">{error}</p>}

      {runs === null ? (
        <p className="loading">Loading…</p>
      ) : runs.length === 0 ? (
        <div className="empty-state">
          <p>No workflow runs recorded recently.</p>
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
            <RunCard key={run.instanceId} run={run} />
          ))}
        </>
      )}
    </div>
  );
}
