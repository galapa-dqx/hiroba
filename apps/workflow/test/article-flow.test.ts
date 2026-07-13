/**
 * ArticleFlow integration — the real engine, the real hub DO, the real
 * FlowEntrypoint shell. Step/unit BODIES are mocked through the pool-workers
 * introspector (they'd hit D1, R2, and three different LLM APIs), so what's
 * under test is what the port changed: the `${itemType}:${itemId}` KEY
 * carrying the one-run-per-item dedup that used to live in the per-item
 * WorkflowManager DO name (news = bare id, topic = prefixed), and the
 * fragment-composed step shape — event segments included — reaching the hub
 * in declaration order.
 */

import { env, introspectWorkflow } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { hub, waitFor } from './helpers';

const NEWS_ID = 'a'.repeat(32);

/** The introspector's per-instance modifier, as handed to modifyAll. */
type InstanceModifier = Parameters<
  Parameters<Awaited<ReturnType<typeof introspectWorkflow>>['modifyAll']>[0]
>[0];

/** Mock every engine step of one happy-path news run (image-free body). */
async function mockHappyPath(m: InstanceModifier): Promise<void> {
  await m.mockStepResult({ name: 'loadLanguages' }, [
    { code: 'en', label: 'English' },
  ]);
  await m.mockStepResult(
    { name: 'fetchBody' },
    { success: true, blockCount: 3 },
  );
  await m.mockStepResult(
    { name: 'extractEvents' },
    { count: 1, eventIds: ['ev1'] },
  );
  await m.mockStepResult(
    { name: 'tagEvents' },
    { tagged: true, timeTags: 1, eventTags: 1, retried: false },
  );
  await m.mockStepResult({ name: 'images/list' }, []);
  await m.mockStepResult(
    { name: 'translate/plan' },
    { mode: 'sync', size: 128 },
  );
  await m.mockStepResult(
    { name: 'translate/sync' },
    { success: true, fieldsTranslated: 2 },
  );
  await m.mockStepResult({ name: 'localizeImages/list' }, []);
  await m.mockStepResult({ name: 'purge' }, null);
}

describe('ArticleFlow on the hub — keyed per (itemType, itemId)', () => {
  it('attaches same-item triggers, keeps types with equal ids apart', async () => {
    const introspector = await introspectWorkflow(env.ARTICLE_WORKFLOW);
    try {
      await introspector.modifyAll(mockHappyPath);

      const first = await hub().start('article', {
        itemType: 'news',
        itemId: NEWS_ID,
      });
      const attached = await hub().start('article', {
        itemType: 'news',
        itemId: NEWS_ID,
      });
      // News and topic id spaces are both 32-char hex — the typed key keeps
      // an identical id from colliding (the old DO-name prefix, moved into
      // the key function).
      const otherType = await hub().start('article', {
        itemType: 'topic',
        itemId: NEWS_ID,
      });
      if (first.throttled || attached.throttled || otherType.throttled) {
        throw new Error('throttled');
      }

      // Re-triggering a running item attaches to the run in flight (the old
      // per-item DO's dedup, moved to the hub)…
      expect(first.created).toBe(true);
      expect(attached.created).toBe(false);
      expect(attached.runId).toBe(first.runId);
      // …while the same id under the other type is its own run, side by side.
      expect(otherType.created).toBe(true);
      expect(otherType.runId).not.toBe(first.runId);

      const run = await waitFor(
        () => hub().getRun(first.runId),
        (r) => r?.status === 'complete',
      );
      // The dedup identity IS the typed id.
      expect(run?.key).toBe(`news:${NEWS_ID}`);
      expect(run?.output).toEqual({
        itemId: NEWS_ID,
        itemType: 'news',
        fetchBody: { success: true, blockCount: 3 },
        extractEvents: { count: 1, eventIds: ['ev1'] },
        tagEvents: { tagged: true, timeTags: 1, eventTags: 1, retried: false },
        mirror: { mirrored: 0, skipped: 0, failed: 0 },
        transcribe: { imagesTranscribed: 0 },
        translate: { success: true, fieldsTranslated: 2 },
        localize: { localized: 0, skipped: 0, failed: 0 },
      });

      // The fragment-composed shape reached the hub in declaration order —
      // event segments between intake and the shared tail.
      const snap = await hub().getSnapshot({ runId: first.runId });
      expect(snap?.order).toEqual([
        'loadLanguages',
        'fetchBody',
        'extractEvents',
        'tagEvents',
        'images',
        'translate',
        'localizeImages',
        'purge',
      ]);

      await waitFor(
        () => hub().getRun(otherType.runId),
        (r) => r?.status === 'complete',
      );

      // The run settled — the same item now starts fresh.
      const again = await hub().start('article', {
        itemType: 'news',
        itemId: NEWS_ID,
      });
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
