/**
 * GlossaryRegenFlow integration — the real engine, the real hub DO, the real
 * FlowEntrypoint shell. Step/unit BODIES are mocked through the pool-workers
 * introspector (they'd hit D1 and remote APIs), so what's under
 * test is what the port changed: keyed dedup at the hub (key = sourceText,
 * replacing the old per-term coordinator-DO-storage mechanism) and the
 * open-handle keyset orchestration driving real engine steps.
 *
 * Unlike BannerFlow's constant key, every test here mints a unique term, so
 * runs only collide when a test means them to.
 */

import { env, introspectWorkflow } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { hub, waitFor } from './helpers';

const uniqueTerm = (): string => `term-${crypto.randomUUID()}`;

/** Mock every engine step the body reaches: one short article page for news,
 *  empty scans for the other types, one short image page. */
async function mockHappyPath(
  introspector: Awaited<ReturnType<typeof introspectWorkflow>>,
): Promise<void> {
  await introspector.modifyAll(async (m) => {
    await m.mockStepResult({ name: 'scanArticles/news:0' }, ['na', 'nb']);
    await m.mockStepResult({ name: 'scanArticles/topic:0' }, []);
    await m.mockStepResult({ name: 'scanArticles/playguide:0' }, []);
    await m.mockStepResult(
      { name: 'retriggerArticles/news:na' },
      { triggered: true },
    );
    await m.mockStepResult(
      { name: 'retriggerArticles/news:nb' },
      { triggered: true },
    );
    await m.mockStepResult({ name: 'languages' }, [
      { code: 'en', label: 'English', nativeLabel: 'English' },
    ]);
    await m.mockStepResult({ name: 'retranslateImages/scan-0' }, [
      { id: 7, textsJa: ['x'] },
    ]);
    await m.mockStepResult(
      { name: 'retranslateImages/translate-0' },
      { translated: 1, skipped: 0, failed: 0 },
    );
  });
}

describe('GlossaryRegenFlow on the hub', () => {
  it('runs the keyset passes to complete with the output at the hub', async () => {
    const introspector = await introspectWorkflow(
      env.GLOSSARY_REGENERATE_WORKFLOW,
    );
    try {
      await mockHappyPath(introspector);
      const sourceText = uniqueTerm();

      const res = await hub().start('glossary-regen', { sourceText });
      if (res.throttled) throw new Error('throttled');
      expect(res.created).toBe(true);

      // Frame one: the full segment map, in declaration order.
      const seeded = await hub().getSnapshot({ runId: res.runId });
      expect(seeded?.order).toEqual([
        'scanArticles',
        'retriggerArticles',
        'languages',
        'retranslateImages',
      ]);

      const snap = await waitFor(
        () => hub().getSnapshot({ runId: res.runId }),
        (s) => s?.status === 'complete',
      );
      expect(snap?.error).toBeNull();

      const run = await hub().getRun(res.runId);
      // The dedup identity IS the term.
      expect(run?.key).toBe(sourceText);
      // The terminal report carries the body's output — `triggered` rebuilt
      // from the memoized scan units, not from any unit that really ran.
      expect(run?.output).toEqual({
        sourceText,
        triggered: 2,
        imagesRetranslated: 1,
      });
    } finally {
      await introspector.dispose();
    }
  });

  it('dedupes per term: same term attaches, another term runs beside it', async () => {
    const introspector = await introspectWorkflow(
      env.GLOSSARY_REGENERATE_WORKFLOW,
    );
    try {
      await mockHappyPath(introspector);
      const termA = uniqueTerm();
      const termB = uniqueTerm();

      const first = await hub().start('glossary-regen', {
        sourceText: termA,
      });
      const attached = await hub().start('glossary-regen', {
        sourceText: termA,
      });
      const other = await hub().start('glossary-regen', {
        sourceText: termB,
      });
      if (first.throttled || attached.throttled || other.throttled) {
        throw new Error('throttled');
      }

      // Re-triggering a running term attaches to the run in flight…
      expect(first.created).toBe(true);
      expect(attached.created).toBe(false);
      expect(attached.runId).toBe(first.runId);
      // …while a different term is its own run, side by side.
      expect(other.created).toBe(true);
      expect(other.runId).not.toBe(first.runId);

      for (const runId of [first.runId, other.runId]) {
        await waitFor(
          () => hub().getRun(runId),
          (run) => run?.status === 'complete',
        );
      }

      // The run settled — the same term now starts fresh.
      const again = await hub().start('glossary-regen', {
        sourceText: termA,
      });
      if (again.throttled) throw new Error('throttled');
      expect(again.created).toBe(true);
      expect(again.runId).not.toBe(first.runId);
      await waitFor(
        () => hub().getRun(again.runId),
        (run) => run?.status === 'complete',
      );
    } finally {
      await introspector.dispose();
    }
  });
});
