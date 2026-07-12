import { describe, expect, it } from 'vitest';

import { defineFlow, phase, step, units } from './define';
import {
  createRunState,
  renderCount,
  seedSnapshot,
  segmentView,
  type StepState,
} from './snapshot';

const def = defineFlow({
  name: 'demo',
  key: (p: { id: string }) => p.id,
  steps: { fetch: step(), translate: phase(), images: units() },
});

describe('seedSnapshot', () => {
  it('seeds every declared step as paintable pending, eagerly', () => {
    const snap = seedSnapshot(def, 'r1');
    expect(snap.status).toBe('queued');
    expect(snap.seq).toBe(0);
    // step and phase seed total=1 (single unit); units seeds indeterminate.
    expect(snap.steps.fetch).toEqual({
      state: 'pending',
      attempt: 0,
      current: 0,
      total: 1,
    });
    expect(snap.steps.translate.total).toBe(1);
    expect(snap.steps.images.total).toBeNull();
  });
});

describe('createRunState', () => {
  it('derives current from distinct units — replayed reports are no-ops', () => {
    const state = createRunState(def, 'r1');
    state.apply({ kind: 'unit', step: 'images', unit: 'a' });
    state.apply({ kind: 'unit', step: 'images', unit: 'b' });
    state.apply({ kind: 'unit', step: 'images', unit: 'a' }); // replay
    expect(state.snapshot().steps.images.current).toBe(2);
  });

  it('bumps seq on every report so SSE frames order and dedupe', () => {
    const state = createRunState(def, 'r1');
    state.apply({ kind: 'step', step: 'fetch', state: 'running' });
    state.apply({ kind: 'unit', step: 'fetch', unit: '1' });
    expect(state.snapshot().seq).toBe(2);
  });

  it('ignores reports for undeclared steps instead of crashing', () => {
    const state = createRunState(def, 'r1');
    state.apply({ kind: 'unit', step: 'nope', unit: '1' });
    expect(state.snapshot().seq).toBe(1);
  });

  it('unfinishedSteps treats skipped as finished (the completeness check)', () => {
    const state = createRunState(def, 'r1');
    state.apply({ kind: 'step', step: 'fetch', state: 'complete' });
    state.apply({ kind: 'step', step: 'translate', state: 'skipped' });
    expect(state.unfinishedSteps()).toEqual(['images']);
    state.apply({ kind: 'step', step: 'images', state: 'complete' });
    expect(state.unfinishedSteps()).toEqual([]);
  });

  it('clears output on any non-complete status (restart-then-fail)', () => {
    const state = createRunState(def, 'r1');
    state.apply({ kind: 'status', status: 'complete', output: { ok: true } });
    expect(state.snapshot().output).toEqual({ ok: true });
    // Engine restart({from}) reruns the instance: running clears, and a
    // subsequent failure must not expose success-shaped output.
    state.apply({ kind: 'status', status: 'running' });
    state.apply({ kind: 'status', status: 'failed', error: 'rerun died' });
    expect(state.snapshot().output).toBeUndefined();
    expect(state.snapshot().error).toBe('rerun died');
  });

  it('snapshots are defensive copies', () => {
    const state = createRunState(def, 'r1');
    const before = state.snapshot();
    state.apply({ kind: 'status', status: 'failed', error: 'boom' });
    expect(before.status).toBe('queued');
    expect(state.snapshot().error).toBe('boom');
  });
});

describe('render helpers', () => {
  const at = (partial: Partial<StepState>): StepState => ({
    state: 'running',
    attempt: 1,
    current: 0,
    total: 1,
    ...partial,
  });

  it('renderCount keys everything off total', () => {
    expect(renderCount(at({ total: 1 }))).toBeNull();
    expect(renderCount(at({ total: null, current: 5 }))).toBe('5…');
    expect(renderCount(at({ total: 10, current: 5 }))).toBe('5/10');
  });

  it('segmentView derives not-reached for pending steps trailing a failure', () => {
    const failed = at({ state: 'failed' });
    const pendingBefore = at({ state: 'pending' });
    const pendingAfter = at({ state: 'pending' });
    expect(segmentView(pendingBefore, 0, 1)).toBe('pending');
    expect(segmentView(failed, 1, 1)).toBe('failed');
    expect(segmentView(pendingAfter, 2, 1)).toBe('not-reached');
    // No failure → pending stays pending; stored skip passes through.
    expect(segmentView(pendingAfter, 2, -1)).toBe('pending');
    expect(segmentView(at({ state: 'skipped' }), 2, -1)).toBe('skipped');
  });
});
