/**
 * Image child flows integration (DQX-27) — the real engine, the real hub DO,
 * real parent AND child FlowEntrypoint shells. Step BODIES are mocked through
 * the pool-workers introspector; what's under test is the join fabric itself:
 * a parent's mapJoin starting real child runs through the hub, hibernating on
 * waitForEvent, being woken by the hub's waiter notification when the child
 * settles, and aggregating the children's outputs — plus THE point of the
 * ticket: two parents referencing the same image attach to ONE ingest child.
 *
 * The sharing test needs the child to stay active while both parents join, so
 * its `mirror` step is forced to time out once — the engine's 10s retry delay
 * is the hold window (both parents reach their join in milliseconds).
 */

import { env, introspectWorkflow } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { hub, waitFor } from './helpers';

/** The introspector's per-instance modifier, as handed to modifyAll. */
type InstanceModifier = Parameters<
  Parameters<Awaited<ReturnType<typeof introspectWorkflow>>['modifyAll']>[0]
>[0];

/** Mock every article engine step around the joins: one referenced image,
 *  sync-sized body, no events. The joins themselves run for real. */
function mockArticleAroundJoins(imageKey: string) {
  return async (m: InstanceModifier): Promise<void> => {
    await m.mockStepResult({ name: 'loadLanguages' }, [
      { code: 'en', label: 'English' },
    ]);
    await m.mockStepResult(
      { name: 'fetchBody' },
      { success: true, blockCount: 3 },
    );
    await m.mockStepResult(
      { name: 'extractEvents' },
      { count: 0, eventIds: [] },
    );
    await m.mockStepResult(
      { name: 'tagEvents' },
      { tagged: false, timeTags: 0, eventTags: 0, retried: false },
    );
    await m.mockStepResult({ name: 'images/list' }, [
      { key: imageKey, transcribe: true },
    ]);
    await m.mockStepResult(
      { name: 'translate/plan' },
      { mode: 'sync', size: 128 },
    );
    await m.mockStepResult(
      { name: 'translate/sync' },
      { success: true, fieldsTranslated: 2 },
    );
    await m.mockStepResult({ name: 'localizeImages/list' }, [
      { key: imageKey, lang: 'en' },
    ]);
    await m.mockStepResult({ name: 'purge' }, null);
  };
}

describe('image child flows on the hub — joined, shared, settled', () => {
  it('two articles referencing one image share ONE ingest child run', async () => {
    const imageKey = `cache.hiroba.dqx.jp/dq_resource/img/${crypto.randomUUID()}.png`;
    const articles = await introspectWorkflow(env.ARTICLE_WORKFLOW);
    const ingests = await introspectWorkflow(env.IMAGE_INGEST_WORKFLOW);
    const localizes = await introspectWorkflow(env.IMAGE_LOCALIZE_WORKFLOW);
    try {
      await articles.modifyAll(mockArticleAroundJoins(imageKey));
      await ingests.modifyAll(async (m) => {
        // The hold: mirror times out once, and the engine's 10s retry delay
        // keeps the child ACTIVE long enough for both parents to join it —
        // then the retry answers from the mock and the child settles.
        await m.forceStepTimeout({ name: 'mirror' }, 1);
        await m.mockStepResult({ name: 'mirror' }, 'mirrored');
        await m.mockStepResult({ name: 'transcribe' }, true);
      });
      await localizes.modifyAll(async (m) => {
        await m.mockStepResult({ name: 'generate' }, 'localized');
      });

      // Two DIFFERENT parents (distinct article keys), one shared image.
      const first = await hub().start('article', {
        itemType: 'news',
        itemId: crypto.randomUUID().replaceAll('-', ''),
      });
      const second = await hub().start('article', {
        itemType: 'topic',
        itemId: crypto.randomUUID().replaceAll('-', ''),
      });
      if (first.throttled || second.throttled) throw new Error('throttled');
      expect(second.runId).not.toBe(first.runId);

      // Both parents hibernate on the held child, wake on the hub's waiter
      // notification, and settle with the child outputs aggregated.
      const expectTail = {
        mirror: { mirrored: 1, skipped: 0, failed: 0 },
        transcribe: { imagesTranscribed: 1 },
        localize: { localized: 1, skipped: 0, failed: 0 },
      };
      for (const runId of [first.runId, second.runId]) {
        const run = await waitFor(
          () => hub().getRun(runId),
          (r) => r?.status === 'complete',
          25_000,
        );
        expect(run?.output).toMatchObject(expectTail);
      }

      // THE assertion of DQX-27: one image → one ingest child run, keyed by
      // the image key, no matter how many parents referenced it. (The hub's
      // keyed dedup replaced the D1 image-row state machine here.)
      const ingestRuns = (
        await hub().listRuns({ flow: 'image-ingest' })
      ).filter((r) => r.key === imageKey);
      expect(ingestRuns).toHaveLength(1);
      expect(ingestRuns[0].status).toBe('complete');
      expect(ingestRuns[0].output).toEqual({
        imageKey,
        mirror: 'mirrored',
        transcribed: true,
      });

      // The localize children ran keyed per (image, language). The parents
      // may or may not have shared one (the second join can land after the
      // first child settled, which correctly starts a fresh idempotent run) —
      // but every run for this image settled complete.
      const localizeRuns = (
        await hub().listRuns({ flow: 'image-localize' })
      ).filter((r) => r.key === `${imageKey}:en`);
      expect(localizeRuns.length).toBeGreaterThanOrEqual(1);
      for (const run of localizeRuns) {
        expect(run.status).toBe('complete');
        expect(run.output).toEqual({
          imageKey,
          lang: 'en',
          outcome: 'localized',
        });
      }
    } finally {
      await articles.dispose();
      await ingests.dispose();
      await localizes.dispose();
    }
  }, 45_000);

  it('a failed child degrades the parent instead of failing it', async () => {
    const imageKey = `cache.hiroba.dqx.jp/dq_resource/img/${crypto.randomUUID()}.png`;
    const articles = await introspectWorkflow(env.ARTICLE_WORKFLOW);
    const ingests = await introspectWorkflow(env.IMAGE_INGEST_WORKFLOW);
    const localizes = await introspectWorkflow(env.IMAGE_LOCALIZE_WORKFLOW);
    try {
      await articles.modifyAll(mockArticleAroundJoins(imageKey));
      await ingests.modifyAll(async (m) => {
        // Every attempt dies → the child RUN fails (not a domain degrade —
        // those settle complete with a failed outcome in the output).
        await m.disableRetryDelays();
        await m.mockStepError({ name: 'mirror' }, new Error('R2 exploded'));
      });
      await localizes.modifyAll(async (m) => {
        await m.mockStepResult({ name: 'generate' }, 'failed');
      });

      const started = await hub().start('article', {
        itemType: 'news',
        itemId: crypto.randomUUID().replaceAll('-', ''),
      });
      if (started.throttled) throw new Error('throttled');

      // Settled semantics all the way through: the parent COMPLETES, counting
      // the dead child into `failed` — degrade, don't block.
      const run = await waitFor(
        () => hub().getRun(started.runId),
        (r) => r?.status === 'complete',
        25_000,
      );
      expect(run?.output).toMatchObject({
        mirror: { mirrored: 0, skipped: 0, failed: 1 },
        transcribe: { imagesTranscribed: 0 },
        // The generate child settled complete with a failed OUTCOME — the
        // other degrade shape, counted the same way.
        localize: { localized: 0, skipped: 0, failed: 1 },
      });

      const ingestRuns = (
        await hub().listRuns({ flow: 'image-ingest' })
      ).filter((r) => r.key === imageKey);
      expect(ingestRuns).toHaveLength(1);
      expect(ingestRuns[0].status).toBe('failed');
    } finally {
      await articles.dispose();
      await ingests.dispose();
      await localizes.dispose();
    }
  }, 45_000);
});
