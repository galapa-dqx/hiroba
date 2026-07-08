/**
 * RunCard — one ArticleWorkflow run as a live status card: a chevron strip of
 * pipeline stages (fetch → mirror → transcribe → translate → localize), an
 * overall progress bar, and — for the multi-image stages — a stacked
 * per-image list with a spinner on whichever images are mid-flight. All stage
 * states are derived client-side from the run's StateSnapshot + per-image
 * detail; the wire stays machine-readable.
 *
 * Shared by the workflow tracker page (all runs) and the article edit page
 * (the run for the article being edited).
 */

import {
  isRunActive,
  type ImagePipelineDetail,
  type PhaseState,
  type WorkflowRunEntry,
} from '@hiroba/shared';
import { formatRelativePast } from '@hiroba/ui/format-date';

/** `partial` = settled with some failures (degraded, not blocking). */
type StageState = PhaseState | 'partial';

type StageItem = { label: string; state: PhaseState };

type Stage = {
  key: string;
  label: string;
  state: StageState;
  /** done+failed / total counter for per-image stages. */
  counter?: string;
  /** Stacked per-item rows (the multi-image stages). */
  items?: StageItem[];
};

/** Fold one per-image step's states into a stage state. */
function foldImageStates(
  states: PhaseState[],
  upstreamDone: boolean,
): StageState {
  if (states.length === 0) return upstreamDone ? 'done' : 'pending';
  if (states.some((s) => s === 'running')) return 'running';
  const settled = states.filter((s) => s === 'done' || s === 'failed');
  if (settled.length === states.length) {
    if (states.every((s) => s === 'failed')) return 'failed';
    return states.some((s) => s === 'failed') ? 'partial' : 'done';
  }
  // Some images settled, none marked running: the step is between images.
  return settled.length > 0 ? 'running' : 'pending';
}

function imageStage(
  key: string,
  label: string,
  images: ImagePipelineDetail[],
  pick: (img: ImagePipelineDetail) => PhaseState,
  upstreamDone: boolean,
): Stage {
  const states = images.map(pick);
  const settled = states.filter((s) => s === 'done' || s === 'failed').length;
  return {
    key,
    label,
    state: foldImageStates(states, upstreamDone),
    counter: images.length > 0 ? `${settled}/${images.length}` : undefined,
    items: images.map((img, i) => ({ label: `Image ${i}`, state: pick(img) })),
  };
}

function deriveStages(run: WorkflowRunEntry): Stage[] {
  const s = run.snapshot;
  const fetched = s.article === 'done';
  const stages: Stage[] = [{ key: 'fetch', label: 'Fetch', state: s.article }];

  if (s.images) {
    stages.push(
      imageStage('mirror', 'Mirror', run.images, (i) => i.mirror, fetched),
      imageStage(
        'transcribe',
        'Transcribe',
        run.images,
        (i) => i.transcribe,
        fetched,
      ),
    );
  }

  stages.push({ key: 'translate', label: 'Translate', state: s.translation });

  if (s.images) {
    // Localize runs over Japanese-text-bearing images only; the candidate set
    // is unknown until transcription settles (hasText null).
    const unknown = run.images.some((i) => i.hasText === null);
    const candidates = run.images
      .map((img, i) => ({ img, i }))
      .filter(({ img }) => img.localize !== null);
    const states = candidates.map(({ img }) => img.localize!);
    const settled = states.filter(
      (st) => st === 'done' || st === 'failed',
    ).length;
    stages.push({
      key: 'localize',
      label: 'Localize',
      state:
        unknown || run.images.length === 0
          ? fetched && run.images.length === 0
            ? 'done'
            : 'pending'
          : foldImageStates(states, true),
      counter:
        candidates.length > 0 ? `${settled}/${states.length}` : undefined,
      items: candidates.map(({ img, i }) => ({
        label: `Image ${i}`,
        state: img.localize!,
      })),
    });
  }

  return stages;
}

const isSettledState = (s: StageState): boolean =>
  s === 'done' || s === 'failed' || s === 'partial';

/** Overall progress: settled stages count 1, per-image stages fractionally. */
function progressPercent(stages: Stage[]): number {
  let sum = 0;
  for (const st of stages) {
    if (isSettledState(st.state)) {
      sum += 1;
    } else if (st.counter) {
      const [settled, total] = st.counter.split('/').map(Number);
      if (total > 0) sum += settled / total;
    } else if (st.state === 'running') {
      sum += 0.5;
    }
  }
  return Math.round((sum / stages.length) * 100);
}

function StateGlyph({ state, spin }: { state: StageState; spin?: boolean }) {
  if (spin || state === 'running')
    return <span className="wf-spinner" aria-label="in progress" />;
  const glyph = { done: '✓', failed: '✕', partial: '△', pending: '·' }[state];
  return (
    <span className="wf-glyph" aria-hidden="true">
      {glyph}
    </span>
  );
}

export default function RunCard({ run }: { run: WorkflowRunEntry }) {
  const stages = deriveStages(run);
  const active = isRunActive(run.status);
  const pct = progressPercent(stages);

  // The stage the run is currently on: the first one still moving. When the
  // run is live but between tracked stages (e.g. extracting events), the next
  // pending stage carries the highlight as "up next".
  const activeIdx = active
    ? stages.findIndex((st) => !isSettledState(st.state))
    : -1;
  const failedIdx = stages.findIndex((st) => st.state === 'failed');
  const currentLabel = !active
    ? run.status === 'complete'
      ? 'Complete'
      : (stages[failedIdx]?.label ?? '—')
    : (stages[activeIdx]?.label ?? 'Finishing');

  // Stacked per-item detail: the active multi-image stage while running; on a
  // settled run, any image stage that ended with failures (diagnostics).
  const detailStage = active
    ? activeIdx >= 0 && stages[activeIdx].items?.length
      ? stages[activeIdx]
      : undefined
    : stages.find(
        (st) =>
          (st.state === 'partial' || st.state === 'failed') && st.items?.length,
      );

  const title = run.titleEn ?? run.titleJa ?? run.itemId;
  const sourceUrl =
    run.itemType === 'topic'
      ? `https://hiroba.dqx.jp/sc/topics/detail/${run.itemId}/`
      : `https://hiroba.dqx.jp/sc/news/detail/${run.itemId}`;

  return (
    <article className={`wf-run${active ? '' : ' wf-run--settled'}`}>
      <header className="wf-run__head">
        <span className={`wf-run__type wf-run__type--${run.itemType}`}>
          {run.itemType}
        </span>
        <a
          className="wf-run__title"
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {title}
        </a>
        <span className="wf-run__started">
          started {formatRelativePast(run.startedAt)}
        </span>
      </header>

      <div className="wf-run__summary">
        <span>
          Stage: <strong>{currentLabel}</strong>
        </span>
        <span>
          Status:{' '}
          <strong className={`wf-status--${run.status}`}>{run.status}</strong>
        </span>
        <span className="wf-run__progress">
          Progress: <strong>{pct}%</strong>
          <span
            className="wf-progress"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className="wf-progress__fill" style={{ width: `${pct}%` }} />
          </span>
        </span>
      </div>

      <ol className="wf-stages">
        {stages.map((st, i) => (
          <li
            key={st.key}
            className={`wf-stage is-${st.state}${i === activeIdx ? ' is-active' : ''}`}
          >
            <StateGlyph state={st.state} spin={i === activeIdx && active} />
            <span>
              {st.label}
              {st.counter ? ` ${st.counter}` : ''}
            </span>
          </li>
        ))}
      </ol>

      {detailStage?.items && (
        <ul className="wf-substeps">
          {detailStage.items.map((item) => (
            <li key={item.label} className={`is-${item.state}`}>
              <StateGlyph state={item.state} />
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      )}

      {run.error && <p className="wf-run__error">{run.error}</p>}
    </article>
  );
}
