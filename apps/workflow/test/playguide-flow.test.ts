/**
 * PlayguideFlow integration — the real engine, the real hub DO, the real
 * FlowEntrypoint shell. Step/unit BODIES are mocked through the pool-workers
 * introspector (they'd hit D1, R2, and three different LLM APIs), so what's
 * under test is what the split changed: the slug KEY carrying the
 * one-run-per-guide dedup that used to live in the `playguide:<slug>`
 * WorkflowManager DO name, and the fragment-composed step shape reaching the
 * hub in declaration order with no event segments.
 */

import { env, introspectWorkflow } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { hub, waitFor } from './helpers';

const KEY = 'cache.hiroba.dqx.jp/dq_resource/img/hero.png';

/** The introspector's per-instance modifier, as handed to modifyAll. */
type InstanceModifier = Parameters<
  Parameters<Awaited<ReturnType<typeof introspectWorkflow>>['modifyAll']>[0]
>[0];

/** Mock every engine step of one happy-path run. The image units are JOINS
 *  since DQX-27 — mocking each join's memoized `start` step with an
 *  already-terminal WatchResult (child output included) settles the unit
 *  without touching the hub; test/image-flows.test.ts covers the real join
 *  transport. */
async function mockHappyPath(m: InstanceModifier): Promise<void> {
  await m.mockStepResult({ name: 'loadLanguages' }, [
    { code: 'en', label: 'English' },
  ]);
  await m.mockStepResult(
    { name: 'fetchBody' },
    { success: true, blockCount: 3 },
  );
  await m.mockStepResult({ name: 'images/list' }, [
    { key: KEY, transcribe: true },
  ]);
  await m.mockStepResult(
    { name: `images/${KEY}/start` },
    {
      runId: 'child-ingest',
      status: 'complete',
      error: null,
      output: { imageKey: KEY, mirror: 'mirrored', transcribed: true },
    },
  );
  await m.mockStepResult(
    { name: 'translate/plan' },
    { mode: 'sync', size: 128 },
  );
  await m.mockStepResult(
    { name: 'translate/sync' },
    { success: true, fieldsTranslated: 2 },
  );
  await m.mockStepResult({ name: 'localizeImages/list' }, [
    { key: KEY, lang: 'en' },
  ]);
  await m.mockStepResult(
    { name: `localizeImages/${KEY}:en/start` },
    {
      runId: 'child-localize',
      status: 'complete',
      error: null,
      output: { imageKey: KEY, lang: 'en', outcome: 'localized' },
    },
  );
  await m.mockStepResult({ name: 'purge' }, null);
}

describe('PlayguideFlow on the hub — keyed per slug', () => {
  it('attaches same-slug triggers, runs other slugs beside them', async () => {
    const introspector = await introspectWorkflow(env.PLAYGUIDE_WORKFLOW);
    try {
      await introspector.modifyAll(mockHappyPath);

      const first = await hub().start('playguide', { slug: 'guide01' });
      const attached = await hub().start('playguide', { slug: 'guide01' });
      const other = await hub().start('playguide', { slug: 'guide02' });
      if (first.throttled || attached.throttled || other.throttled) {
        throw new Error('throttled');
      }

      // Re-triggering a running guide attaches to the run in flight (the old
      // per-slug DO's dedup, moved to the hub)…
      expect(first.created).toBe(true);
      expect(attached.created).toBe(false);
      expect(attached.runId).toBe(first.runId);
      // …while a different guide is its own run, side by side.
      expect(other.created).toBe(true);
      expect(other.runId).not.toBe(first.runId);

      const run = await waitFor(
        () => hub().getRun(first.runId),
        (r) => r?.status === 'complete',
      );
      // The dedup identity IS the slug.
      expect(run?.key).toBe('guide01');
      expect(run?.output).toEqual({
        slug: 'guide01',
        fetchBody: { success: true, blockCount: 3 },
        mirror: { mirrored: 1, skipped: 0, failed: 0 },
        transcribe: { imagesTranscribed: 1 },
        translate: { success: true, fieldsTranslated: 2 },
        localize: { localized: 1, skipped: 0, failed: 0 },
      });

      // The fragment-composed shape reached the hub in declaration order —
      // and carries no event segments at all.
      const snap = await hub().getSnapshot({ runId: first.runId });
      expect(snap?.order).toEqual([
        'loadLanguages',
        'fetchBody',
        'images',
        'translate',
        'localizeImages',
        'purge',
      ]);

      await waitFor(
        () => hub().getRun(other.runId),
        (r) => r?.status === 'complete',
      );

      // The run settled — the same slug now starts fresh.
      const again = await hub().start('playguide', { slug: 'guide01' });
      if (again.throttled) throw new Error('throttled');
      expect(again.created).toBe(true);
      expect(again.runId).not.toBe(first.runId);
      await waitFor(
        () => hub().getRun(again.runId),
        (r) => r?.status === 'complete',
      );
    } finally {
      await introspector.dispose();
    }
  });
});
