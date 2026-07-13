/**
 * BannerFlow integration — the real engine, the real hub DO, the real
 * FlowEntrypoint shell. Step BODIES are mocked through the pool-workers
 * introspector (they'd hit the live site and three LLM APIs), so what's under
 * test is what the port changed: orchestration, hub tracking, and terminal
 * reporting.
 *
 * One introspector caveat shapes the assertions: a mocked step never executes
 * its body, and step-state reports live INSIDE bodies by design — so a mocked
 * step's segment stays `pending`, exactly like a step replayed over its memo.
 * Segment truth for really-executed steps is covered by the inline tier
 * (src/banner-flow.test.ts). Crucially, `f.skip` is flow-body code, not a step
 * body: the early-exit skips DO run here and land in the real hub, so stored
 * skips are proven end to end.
 *
 * BannerFlow's key is constant ('banners'), so runs dedup globally — each test
 * drives its run to terminal before finishing.
 */

import { env, introspectWorkflow } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Snapshot } from '@hiroba/flow';

import { hub, waitFor } from './helpers';

const ORDER = [
  'scrape',
  'languages',
  'mirror',
  'transcribe',
  'translate',
  'localize',
] as const;

describe('BannerFlow on the hub', () => {
  it('runs the six-step happy path to complete with the output at the hub', async () => {
    const introspector = await introspectWorkflow(env.BANNER_WORKFLOW);
    try {
      await introspector.modifyAll(async (m) => {
        await m.mockStepResult({ name: 'scrape' }, [
          'cache.hiroba.dqx.jp/dq_resource/img/banner_rotation_20260701_001.jpg',
          'cache.hiroba.dqx.jp/dq_resource/img/banner_rotation_20260702_002.jpg',
        ]);
        await m.mockStepResult({ name: 'languages' }, [
          { code: 'en', label: 'English', nativeLabel: 'English' },
        ]);
        await m.mockStepResult(
          { name: 'mirror' },
          { mirrored: 2, skipped: 0, failed: 0 },
        );
        await m.mockStepResult({ name: 'transcribe' }, 2);
        await m.mockStepResult(
          { name: 'translate' },
          { translated: 2, skipped: 0, failed: 0 },
        );
        await m.mockStepResult(
          { name: 'localize' },
          { localized: 2, skipped: 0, failed: 0 },
        );
      });

      const res = await hub().start('banner', {});
      if (res.throttled) throw new Error('throttled');
      expect(res.created).toBe(true);

      // Immediately after start the full segment map is already paintable —
      // the seeded pending steps ARE the segment bar's frame one.
      const seeded = await hub().getSnapshot({ runId: res.runId });
      expect(seeded?.order).toEqual([...ORDER]);

      const snap = await waitFor(
        () => hub().getSnapshot({ runId: res.runId }),
        (s) => s?.status === 'complete',
      );
      expect(snap?.error).toBeNull();
      // No stored skips on the happy path (mocked steps read pending — see
      // the header comment).
      for (const key of ORDER) {
        expect(snap?.steps[key].state).not.toBe('skipped');
        expect(snap?.steps[key].state).not.toBe('failed');
      }

      // The FlowEntrypoint shell's terminal report carries the body's output.
      const run = await hub().getRun(res.runId);
      expect(run?.output).toEqual({
        banners: 2,
        mirrored: 2,
        transcribed: 2,
        localized: 2,
      });
    } finally {
      await introspector.dispose();
    }
  });

  it('stores skips for the five trailing steps on an empty scrape', async () => {
    const introspector = await introspectWorkflow(env.BANNER_WORKFLOW);
    try {
      await introspector.modifyAll(async (m) => {
        await m.mockStepResult({ name: 'scrape' }, []);
      });

      const res = await hub().start('banner', {});
      if (res.throttled) throw new Error('throttled');
      expect(res.created).toBe(true);

      const snap = await waitFor(
        () => hub().getSnapshot({ runId: res.runId }),
        (s) => s?.status === 'complete',
      );
      // The early-exit skips are body code (not step bodies), so they really
      // ran and were stored — this is the segment strip the panel paints.
      for (const key of ORDER.slice(1)) {
        expect(snap?.steps[key].state).toBe('skipped');
      }

      const run = await hub().getRun(res.runId);
      expect(run?.output).toEqual({
        banners: 0,
        mirrored: 0,
        transcribed: 0,
        localized: 0,
      });

      // The listing the admin "Flow runs" panel polls: the run is there with
      // its snapshot embedded, skipped segments included.
      const response = await hub().fetch('https://hub/runs?flow=banner');
      expect(response.status).toBe(200);
      const { runs } = (await response.json()) as {
        runs: Array<{ runId: string; snapshot: Snapshot | null }>;
      };
      const mine = runs.find((r) => r.runId === res.runId);
      expect(mine?.snapshot?.status).toBe('complete');
      expect(mine?.snapshot?.steps.localize.state).toBe('skipped');
    } finally {
      await introspector.dispose();
    }
  });
});
