import { describe, expect, it } from 'vitest';

import type { Snapshot } from '@hiroba/flow';
import type { RunInfo } from '@hiroba/flow/hub';
import { describeItemRun, itemRunHealth } from '@hiroba/flows';

import { resolveArticleView } from './article-view';
import {
  CACHE_ARTICLE_COMPLETE,
  CACHE_ARTICLE_DEGRADED,
  CACHE_NONE,
} from './cache';

/** A hub RunInfo with just the fields the gate reads. */
function run(status: RunInfo['status'], output?: unknown): RunInfo {
  return {
    runId: 'r1',
    flow: 'article',
    key: 'news:1',
    params: null,
    status,
    error: status === 'failed' ? 'step exhausted retries' : null,
    output,
    createdAt: 0,
    updatedAt: 0,
  };
}

const CLEAN_OUTPUT = {
  fetchBody: { success: true },
  translate: { success: true },
  localize: { localized: 2, skipped: 0, failed: 0 },
};

describe('itemRunHealth', () => {
  it('grades active, clean, degraded, fetch-failed, and dead runs', () => {
    expect(itemRunHealth(run('running'))).toBe('active');
    expect(itemRunHealth(run('queued'))).toBe('active');
    expect(itemRunHealth(run('complete', CLEAN_OUTPUT))).toBe('complete');
    expect(
      itemRunHealth(
        run('complete', { ...CLEAN_OUTPUT, localize: { failed: 1 } }),
      ),
    ).toBe('degraded');
    expect(
      itemRunHealth(run('complete', { fetchBody: { success: false } })),
    ).toBe('fetch-failed');
    expect(itemRunHealth(run('failed'))).toBe('failed');
    expect(itemRunHealth(run('unknown' as RunInfo['status']))).toBe('failed');
  });

  it('reads a missing or unshaped output as complete', () => {
    expect(itemRunHealth(run('complete'))).toBe('complete');
    expect(itemRunHealth(run('complete', 'weird'))).toBe('complete');
  });
});

describe('resolveArticleView', () => {
  it('an active run is processing regardless of content', () => {
    for (const hasContent of [true, false]) {
      const view = resolveArticleView(hasContent, run('running'));
      expect(view.phase).toBe('processing');
      expect(view.ready).toBe(false);
      expect(view.cacheControl).toBe(CACHE_NONE);
      expect(view.trigger).toBeNull();
    }
  });

  it('content + clean (or pruned) settle caches hard with no trigger', () => {
    for (const r of [null, run('complete', CLEAN_OUTPUT)]) {
      const view = resolveArticleView(true, r);
      expect(view.phase).toBe('ready-complete');
      expect(view.ready).toBe(true);
      expect(view.cacheControl).toBe(CACHE_ARTICLE_COMPLETE);
      expect(view.trigger).toBeNull();
    }
  });

  it('content + degraded/failed settle displays with a cooldown heal', () => {
    for (const r of [
      run('complete', { ...CLEAN_OUTPUT, localize: { failed: 2 } }),
      run('failed'),
    ]) {
      const view = resolveArticleView(true, r);
      expect(view.phase).toBe('ready-degraded');
      expect(view.ready).toBe(true);
      expect(view.cacheControl).toBe(CACHE_ARTICLE_DEGRADED);
      expect(view.trigger).toBe('cooldown');
    }
  });

  it('no content + no run (or a stale complete run) forces a fresh start', () => {
    for (const r of [null, run('complete', CLEAN_OUTPUT)]) {
      const view = resolveArticleView(false, r);
      expect(view.phase).toBe('processing');
      expect(view.trigger).toBe('force');
      expect(view.cacheControl).toBe(CACHE_NONE);
    }
  });

  it('no content + dead-end settles retry only on the cooldown', () => {
    const fetchFailed = resolveArticleView(
      false,
      run('complete', { fetchBody: { success: false } }),
    );
    expect(fetchFailed.phase).toBe('fetch-failed');
    expect(fetchFailed.trigger).toBe('cooldown');

    const dead = resolveArticleView(false, run('failed'));
    expect(dead.phase).toBe('run-failed');
    expect(dead.trigger).toBe('cooldown');
    expect(dead.ready).toBe(false);
  });
});

describe('describeItemRun', () => {
  const step = (state: string, current = 0, total: number | null = 1) => ({
    state,
    attempt: 1,
    current,
    total,
  });

  function snap(steps: Record<string, ReturnType<typeof step>>): Snapshot {
    return {
      flow: 'article',
      runId: 'r1',
      status: 'running',
      error: null,
      seq: 1,
      order: Object.keys(steps),
      steps,
    } as unknown as Snapshot;
  }

  it('narrates the first unfinished step, with unit counters', () => {
    expect(
      describeItemRun(
        snap({ loadLanguages: step('complete'), fetchBody: step('running') }),
      ),
    ).toBe('Fetching content…');
    expect(
      describeItemRun(
        snap({
          fetchBody: step('complete'),
          images: step('running', 3, 12),
          translate: step('pending'),
        }),
      ),
    ).toBe('Processing images (3/12)…');
    expect(
      describeItemRun(
        snap({
          translate: step('complete'),
          localizeImages: step('running', 2, null),
        }),
      ),
    ).toBe('Translating images (2…)…');
  });

  it('skipped steps are passed over; an all-finished snapshot finishes up', () => {
    expect(
      describeItemRun(
        snap({
          fetchBody: step('complete'),
          extractEvents: step('skipped'),
          translate: step('running'),
        }),
      ),
    ).toBe('Translating…');
    expect(describeItemRun(snap({ purge: step('complete') }))).toBe(
      'Finishing up…',
    );
  });
});
