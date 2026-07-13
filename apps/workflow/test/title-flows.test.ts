/**
 * TitleFlow + TitleBackfillFlow integration — the real engine, the real hub
 * DO, the real FlowEntrypoint shells. Step/unit BODIES are mocked through the
 * pool-workers introspector (they'd hit D1 and Gemini), so what's under test
 * is what the port changed: the two dedup postures at the hub. TitleFlow's
 * key is RANDOM — the dedup opt-out — so identical params must still create
 * disjoint runs; TitleBackfillFlow is keyed per language — the old
 * `title-backfill:<lang>` DO instance's activeBackfills map, moved to the hub
 * — so concurrent triggers for a language attach.
 */

import { env, introspectWorkflow } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { hub, waitFor } from './helpers';

describe('TitleFlow on the hub — random key, no attach semantics', () => {
  it('creates a disjoint run per start, even for identical params', async () => {
    const introspector = await introspectWorkflow(env.TITLE_WORKFLOW);
    try {
      await introspector.modifyAll(async (m) => {
        await m.mockStepResult({ name: 'loadTitles' }, [
          { id: 'a', titleJa: 'タイトル' },
        ]);
        await m.mockStepResult({ name: 'languages' }, ['en']);
        await m.mockStepResult({ name: 'translate/list' }, [
          {
            language: 'en',
            index: 0,
            chunk: [{ id: 'a', titleJa: 'タイトル' }],
          },
        ]);
        await m.mockStepResult(
          { name: 'translate/en:0' },
          { translated: 1, failed: 0 },
        );
      });

      const params = { itemType: 'news', itemIds: ['a'] };
      const first = await hub().start('title', params);
      const second = await hub().start('title', params);
      if (first.throttled || second.throttled) throw new Error('throttled');

      // The dedup opt-out: same params, still two runs — a batch must never
      // attach to (and silently drop its ids into) another batch's run.
      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(second.runId).not.toBe(first.runId);

      for (const runId of [first.runId, second.runId]) {
        const run = await waitFor(
          () => hub().getRun(runId),
          (r) => r?.status === 'complete',
        );
        expect(run?.output).toEqual({
          itemType: 'news',
          translated: 1,
          failed: 0,
        });
      }

      // Distinct random keys are what carried the no-attach semantics.
      const keyA = (await hub().getRun(first.runId))?.key;
      const keyB = (await hub().getRun(second.runId))?.key;
      expect(keyA).not.toBe(keyB);
    } finally {
      await introspector.dispose();
    }
  });
});

describe('TitleBackfillFlow on the hub — keyed per language', () => {
  it('attaches same-language triggers, runs other languages beside them', async () => {
    const introspector = await introspectWorkflow(env.TITLE_BACKFILL_WORKFLOW);
    try {
      // Every scan comes back empty: each sweep ends on its first probe.
      await introspector.modifyAll(async (m) => {
        for (const itemType of ['news', 'topic', 'playguide']) {
          await m.mockStepResult({ name: `${itemType}/scan-0` }, []);
        }
      });

      const first = await hub().start('title-backfill', { language: 'ko' });
      const attached = await hub().start('title-backfill', { language: 'ko' });
      const other = await hub().start('title-backfill', { language: 'fr' });
      if (first.throttled || attached.throttled || other.throttled) {
        throw new Error('throttled');
      }

      // Re-triggering a running language attaches to the run in flight…
      expect(first.created).toBe(true);
      expect(attached.created).toBe(false);
      expect(attached.runId).toBe(first.runId);
      // …while a different language is its own run, side by side.
      expect(other.created).toBe(true);
      expect(other.runId).not.toBe(first.runId);

      for (const runId of [first.runId, other.runId]) {
        await waitFor(
          () => hub().getRun(runId),
          (run) => run?.status === 'complete',
        );
      }

      const run = await hub().getRun(first.runId);
      // The dedup identity IS the language.
      expect(run?.key).toBe('ko');
      expect(run?.output).toEqual({
        language: 'ko',
        scanned: 0,
        translated: 0,
        failed: 0,
      });

      // Frame one: one segment per item type, in scan order.
      const snap = await hub().getSnapshot({ runId: first.runId });
      expect(snap?.order).toEqual(['news', 'topic', 'playguide']);

      // The run settled — the same language now starts fresh.
      const again = await hub().start('title-backfill', { language: 'ko' });
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

  it('throttles a cooled-down key but lets force through', async () => {
    const introspector = await introspectWorkflow(env.TITLE_BACKFILL_WORKFLOW);
    try {
      await introspector.modifyAll(async (m) => {
        for (const itemType of ['news', 'topic', 'playguide']) {
          await m.mockStepResult({ name: `${itemType}/scan-0` }, []);
        }
      });

      // The web list-view trigger passes a cooldown; the admin pre-warm forces.
      const cooldownMs = 60 * 60 * 1000;
      const first = await hub().start(
        'title-backfill',
        { language: 'de' },
        { cooldownMs },
      );
      if (first.throttled) throw new Error('unexpected throttle');
      await waitFor(
        () => hub().getRun(first.runId),
        (run) => run?.status === 'complete',
      );

      // Settled, but within the cooldown window: a page-view trigger is
      // swallowed (this is what guards a straggler-laden archive from
      // starting a fresh scan on every list view)…
      const throttled = await hub().start(
        'title-backfill',
        { language: 'de' },
        { cooldownMs },
      );
      expect(throttled.throttled).toBe(true);

      // …while the admin pre-warm bypasses it.
      const forced = await hub().start(
        'title-backfill',
        { language: 'de' },
        { force: true },
      );
      if (forced.throttled) throw new Error('forced start throttled');
      expect(forced.created).toBe(true);
      await waitFor(
        () => hub().getRun(forced.runId),
        (run) => run?.status === 'complete',
      );
    } finally {
      await introspector.dispose();
    }
  });
});
