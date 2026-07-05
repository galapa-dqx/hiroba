import { describe, expect, it } from 'vitest';

import {
  aggregateStates,
  describeSnapshot,
  isSnapshotComplete,
  isSnapshotSettled,
  type StateSnapshot,
  type StepProgress,
} from './pipeline-state';

const progress = (
  done: number,
  failed: number,
  total: number,
): StepProgress => ({
  done,
  failed,
  total,
});

/** A topic snapshot with N images, all steps finished cleanly. */
const allDone = (total = 3): NonNullable<StateSnapshot['images']> => ({
  mirror: progress(total, 0, total),
  transcribe: progress(total, 0, total),
  localize: progress(total, 0, total),
});

const snapshot = (over: Partial<StateSnapshot> = {}): StateSnapshot => ({
  article: 'done',
  translation: 'done',
  images: null,
  ...over,
});

describe('aggregateStates', () => {
  it('is done for an empty list (nothing to wait on)', () => {
    expect(aggregateStates([])).toBe('done');
  });

  it('fails if anything failed, regardless of the rest', () => {
    expect(aggregateStates(['done', 'failed', 'running'])).toBe('failed');
  });

  it('runs if anything runs and nothing failed', () => {
    expect(aggregateStates(['done', 'running', 'pending'])).toBe('running');
  });

  it('is pending when some parts have not started', () => {
    expect(aggregateStates(['done', 'pending'])).toBe('pending');
  });

  it('is done only when every part is done', () => {
    expect(aggregateStates(['done', 'done'])).toBe('done');
  });
});

describe('isSnapshotSettled', () => {
  it('settles a fully-done news snapshot (images: null)', () => {
    expect(isSnapshotSettled(snapshot())).toBe(true);
  });

  it('does not settle while translation is in flight', () => {
    expect(isSnapshotSettled(snapshot({ translation: 'running' }))).toBe(false);
  });

  it('settles immediately on a failed prerequisite', () => {
    expect(isSnapshotSettled(snapshot({ article: 'failed' }))).toBe(true);
    expect(
      isSnapshotSettled(
        snapshot({
          translation: 'failed',
          images: { ...allDone(), localize: null },
        }),
      ),
    ).toBe(true);
  });

  it('waits on unsettled image localization', () => {
    expect(
      isSnapshotSettled(
        snapshot({ images: { ...allDone(3), localize: progress(1, 0, 3) } }),
      ),
    ).toBe(false);
  });

  it('settles when every image is done or failed', () => {
    expect(
      isSnapshotSettled(
        snapshot({ images: { ...allDone(3), localize: progress(2, 1, 3) } }),
      ),
    ).toBe(true);
  });

  it('waits on unsettled transcription and the unknown candidate set', () => {
    expect(
      isSnapshotSettled(
        snapshot({
          images: {
            mirror: progress(3, 0, 3),
            transcribe: progress(1, 0, 3),
            localize: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it('does not consult mirroring (it cannot outlive translation)', () => {
    expect(
      isSnapshotSettled(
        snapshot({ images: { ...allDone(3), mirror: progress(1, 1, 3) } }),
      ),
    ).toBe(true);
  });
});

describe('isSnapshotComplete', () => {
  it('requires all components done with zero failed images', () => {
    expect(isSnapshotComplete(snapshot({ images: allDone() }))).toBe(true);
    expect(
      isSnapshotComplete(
        snapshot({ images: { ...allDone(3), localize: progress(2, 1, 3) } }),
      ),
    ).toBe(false);
    expect(
      isSnapshotComplete(
        snapshot({ images: { ...allDone(3), transcribe: progress(2, 1, 3) } }),
      ),
    ).toBe(false);
  });

  it('is unbothered by mirror failures (transcribe falls back to the CDN)', () => {
    expect(
      isSnapshotComplete(
        snapshot({ images: { ...allDone(3), mirror: progress(2, 1, 3) } }),
      ),
    ).toBe(true);
  });
});

describe('describeSnapshot', () => {
  it('walks the pipeline in order', () => {
    expect(describeSnapshot(snapshot({ article: 'running' }))).toBe(
      'Fetching content…',
    );
    expect(
      describeSnapshot(
        snapshot({
          translation: 'pending',
          images: {
            mirror: progress(1, 0, 4),
            transcribe: progress(0, 0, 4),
            localize: null,
          },
        }),
      ),
    ).toBe('Downloading images (1/4)…');
    expect(
      describeSnapshot(
        snapshot({
          translation: 'pending',
          images: {
            mirror: progress(4, 0, 4),
            transcribe: progress(2, 0, 4),
            localize: null,
          },
        }),
      ),
    ).toBe('Reading image text (2/4)…');
    expect(describeSnapshot(snapshot({ translation: 'running' }))).toBe(
      'Translating…',
    );
    expect(
      describeSnapshot(
        snapshot({ images: { ...allDone(4), localize: progress(1, 0, 4) } }),
      ),
    ).toBe('Translating images (1/4)…');
  });

  it('reports failures and degraded completion', () => {
    expect(describeSnapshot(snapshot({ article: 'failed' }))).toBe(
      'Failed to fetch the article.',
    );
    expect(describeSnapshot(snapshot({ translation: 'failed' }))).toBe(
      'Translation failed.',
    );
    expect(
      describeSnapshot(
        snapshot({ images: { ...allDone(3), localize: progress(2, 1, 3) } }),
      ),
    ).toBe('Done — 1 image could not be localized.');
  });
});
