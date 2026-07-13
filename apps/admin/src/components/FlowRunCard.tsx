/**
 * FlowRunCard — one hub flow run as a live status card: the run's identity
 * (for article/playguide runs, the item's translated title linked to its
 * Hiroba source) and the hub segment strip painted from `Snapshot` frames.
 * Per-image work shows up as the image child runs (DQX-27); the D1 pipeline
 * enrichment retired with DQX-28.
 *
 * Shared by the workflow tracker page (all runs) and the article edit page
 * (the run for the article being edited).
 */

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
import type { HubRunStatus } from '@hiroba/flow/hub';
import type { FlowRunItem } from '@hiroba/shared';
import { formatRelativePast } from '@hiroba/ui/format-date';

import type { FlowRunEntry } from '../lib/api';

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

function sourceUrl(item: FlowRunItem): string {
  return item.itemType === 'topic'
    ? `https://hiroba.dqx.jp/sc/topics/detail/${item.itemId}/`
    : item.itemType === 'playguide'
      ? `https://hiroba.dqx.jp/sc/public/playguide/${item.itemId}`
      : `https://hiroba.dqx.jp/sc/news/detail/${item.itemId}`;
}

export default function FlowRunCard({
  run,
  snapshot,
}: {
  run: FlowRunEntry;
  snapshot?: Snapshot;
}) {
  const active = isActive(run.status);
  const item = run.item;
  return (
    <article className={`wf-run${active ? '' : ' wf-run--settled'}`}>
      <header className="wf-run__head">
        <span
          className={`wf-run__type${item ? ` wf-run__type--${item.itemType}` : ''}`}
        >
          {item ? item.itemType : run.flow}
        </span>
        {item ? (
          <a
            className="wf-run__title"
            href={sourceUrl(item)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {item.titleEn ?? item.titleJa ?? item.itemId}
          </a>
        ) : (
          <span className="wf-run__title">{run.key}</span>
        )}
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
