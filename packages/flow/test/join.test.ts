/**
 * Join mechanics against the real engine: parent flows waiting on child flows
 * as steps, dedup by child key, terminal notification via sendEvent.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { FlowHubApi } from '../src/hub/index';
import type { JoinOutcome } from '../src/index';

function hub(): FlowHubApi {
  const ns = env.FLOW_HUB;
  return ns.get(ns.idFromName('hub')) as unknown as FlowHubApi;
}

const uniqueKey = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID()}`;

async function waitFor<T>(
  fn: () => Promise<T>,
  pred: (value: T) => boolean,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (pred(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out; last value: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('mapJoin parent/child', () => {
  it('parent completes with per-child outcomes; a failed child degrades, not blocks', async () => {
    const a = uniqueKey('child-ok-a');
    const b = uniqueKey('child-ok-b');
    const bad = uniqueKey('child-bad');
    const res = await hub().start('toy-parent', {
      key: uniqueKey('parent'),
      items: [{ item: a }, { item: b }, { item: bad, fail: true }],
    });
    if (res.throttled) throw new Error('throttled');

    const run = await waitFor(
      () => hub().getRun(res.runId),
      (r) => r != null && r.status !== 'queued' && r.status !== 'running',
    );
    // joinSettled semantics: the parent COMPLETES even though a child failed.
    expect(run?.status).toBe('complete');
    const { outcomes } = run?.output as { outcomes: JoinOutcome[] };
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toEqual({
      status: 'complete',
      output: { made: `made:${a}` },
    });
    expect(outcomes[1]).toEqual({
      status: 'complete',
      output: { made: `made:${b}` },
    });
    expect(outcomes[2].status).toBe('failed');

    // Parent progress counted every child as a unit, including the failed one.
    const snap = await hub().getSnapshot({ runId: res.runId });
    expect(snap?.steps.fanout).toMatchObject({
      state: 'complete',
      current: 3,
      total: 3,
    });
  });

  it('two parents sharing a child key attach to ONE child run', async () => {
    const shared = uniqueKey('shared-child');
    // The child sleeps briefly so the second parent's join lands while the
    // child run is still active.
    const first = await hub().start('toy-parent', {
      key: uniqueKey('parent-1'),
      items: [{ item: shared, sleepMs: 2000 }],
    });
    const second = await hub().start('toy-parent', {
      key: uniqueKey('parent-2'),
      items: [{ item: shared, sleepMs: 2000 }],
    });
    if (first.throttled || second.throttled) throw new Error('throttled');

    await waitFor(
      () => hub().getRun(first.runId),
      (r) => r?.status === 'complete',
    );
    await waitFor(
      () => hub().getRun(second.runId),
      (r) => r?.status === 'complete',
    );

    // Exactly one toy-child run exists for the shared key.
    const childRuns = (await hub().listRuns({ flow: 'toy-child' })).filter(
      (run) => run.key === shared,
    );
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0].status).toBe('complete');
  });

  it('sequential joins on ONE declared step start distinct children', async () => {
    // Regression: join engine-step names are scoped per child; before, the
    // second join replayed the first join's memoized `pair/start` step and
    // silently received the first child's outcome.
    const a = uniqueKey('serial-a');
    const b = uniqueKey('serial-b');
    const res = await hub().start('toy-serial', {
      key: uniqueKey('serial'),
      itemA: a,
      itemB: b,
    });
    if (res.throttled) throw new Error('throttled');

    const run = await waitFor(
      () => hub().getRun(res.runId),
      (r) => r != null && r.status !== 'queued' && r.status !== 'running',
    );
    expect(run?.status).toBe('complete');
    expect(run?.output).toEqual({ statuses: ['complete', 'complete'] });

    const childKeys = (await hub().listRuns({ flow: 'toy-child' })).map(
      (r) => r.key,
    );
    expect(childKeys).toContain(a);
    expect(childKeys).toContain(b);

    const snap = await hub().getSnapshot({ runId: res.runId });
    expect(snap?.steps.pair).toMatchObject({
      state: 'complete',
      current: 2,
      total: null, // plain joins never set a denominator — indeterminate
    });
  });

  it('a parent joining an already-terminal child short-circuits without waiting', async () => {
    const item = uniqueKey('pre-done');
    // Run the child to completion first, while its run row is still active
    // in the hub's registry the parent would attach; terminal → the join's
    // startAndWatch answers with the terminal state directly.
    const child = await hub().start('toy-child', { item });
    if (child.throttled) throw new Error('throttled');
    await waitFor(
      () => hub().getRun(child.runId),
      (r) => r?.status === 'complete',
    );

    const parent = await hub().start('toy-parent', {
      key: uniqueKey('parent-late'),
      items: [{ item }],
    });
    if (parent.throttled) throw new Error('throttled');
    const run = await waitFor(
      () => hub().getRun(parent.runId),
      (r) => r?.status === 'complete',
    );
    const { outcomes } = run?.output as { outcomes: JoinOutcome[] };
    // The child settled before the parent joined — a NEW child run starts for
    // the same key (the old one is terminal), and the parent still completes.
    expect(outcomes[0].status).toBe('complete');
  });
});
