/**
 * Tracker semantics, exercised through runFlowInline — every test here is a
 * behavior the FlowHub's integration tests (DQX-18) re-verify against the
 * real engine.
 */

import { describe, expect, it } from 'vitest';

import { defineFlow, phase, step, units } from './define';
import { runFlowInline } from './inline';
import { segmentView } from './snapshot';
import {
  DRAIN_STOP,
  FlowJoinError,
  joinRequest,
  type JoinPort,
} from './tracker';

const linear = defineFlow({
  name: 'linear',
  key: (p: { id: string }) => p.id,
  steps: { fetch: step(), write: units(), publish: step() },
});

describe('f.step', () => {
  it('runs the body once, reports pending→running→complete, returns the value', async () => {
    const run = await runFlowInline(
      linear,
      async (f) => {
        const a = await f.step('fetch', async () => 'body');
        await f.map(
          'write',
          async () => [],
          async () => null,
          {
            concurrency: 1,
            id: String,
          },
        );
        await f.step('publish', async () => a.toUpperCase());
        return a;
      },
      { id: 'x' },
    );
    expect(run.error).toBeUndefined();
    expect(run.output).toBe('body');
    expect(run.snapshot.status).toBe('complete');
    expect(run.snapshot.steps.fetch).toMatchObject({
      state: 'complete',
      current: 1,
      total: 1,
      attempt: 1,
    });
    expect(run.unfinishedSteps).toEqual([]);
    // Frames walk through running before complete.
    const fetchStates = run.frames.map((s) => s.steps.fetch.state);
    expect(fetchStates).toContain('running');
    expect(fetchStates.at(-1)).toBe('complete');
  });

  it('rejects undeclared step keys loudly', async () => {
    const run = await runFlowInline(
      linear,
      // @ts-expect-error — undeclared key is a type error AND a runtime error
      async (f) => f.step('nope', async () => 1),
      { id: 'x' },
    );
    expect(String(run.error)).toMatch(/not declared/);
  });
});

describe('f.map', () => {
  const flow = defineFlow({
    name: 'mapper',
    key: () => 'k',
    steps: { write: units() },
  });

  it('collects results in item order and reports total + units', async () => {
    const run = await runFlowInline(
      flow,
      (f) =>
        f.map(
          'write',
          async () => ['a', 'b', 'c'],
          async (item) => item.toUpperCase(),
          { concurrency: 2, id: (item) => item },
        ),
      undefined,
    );
    expect(run.output).toEqual(['A', 'B', 'C']);
    expect(run.snapshot.steps.write).toMatchObject({
      state: 'complete',
      current: 3,
      total: 3,
    });
    // The list step and each unit are real, individually-named engine steps.
    const doNames = run.trace.filter((t) => t.type === 'do').map((t) => t.name);
    expect(doNames).toEqual(
      expect.arrayContaining(['write/list', 'write/a', 'write/b', 'write/c']),
    );
  });

  it('rejects duplicate unit ids before any unit runs', async () => {
    const run = await runFlowInline(
      flow,
      (f) =>
        f.map(
          'write',
          async () => ['a', 'b', 'a'],
          async (item) => item,
          { concurrency: 2, id: (item) => item },
        ),
      undefined,
    );
    expect(String(run.error)).toMatch(/duplicate unit id "a"/);
    expect(run.snapshot.steps.write.state).toBe('failed');
    // Fail-fast: no unit engine step ever dispatched.
    expect(run.trace.some((t) => t.name === 'write/a')).toBe(false);
  });

  it('a failing list step marks the segment failed, not pending', async () => {
    const run = await runFlowInline(
      flow,
      (f) =>
        f.map(
          'write',
          async () => ['a'],
          async (item) => item,
          { concurrency: 1, id: (item) => item },
        ),
      undefined,
      {
        stubs: {
          'write/list': () => {
            throw new Error('list died');
          },
        },
      },
    );
    expect(String(run.error)).toMatch(/list died/);
    expect(run.snapshot.status).toBe('failed');
    expect(run.snapshot.steps.write.state).toBe('failed');
  });

  it('replays without re-running completed units or double-counting', async () => {
    const calls = new Map<string, number>();
    const body = (f: Parameters<Parameters<typeof runFlowInline>[1]>[0]) =>
      f.map(
        'write',
        async () => ['a', 'b', 'c'],
        async (item: string) => {
          calls.set(item, (calls.get(item) ?? 0) + 1);
          return item;
        },
        { concurrency: 1, id: (item: string) => item },
      );

    // First run: unit b's engine step is stubbed to throw — a completes and
    // memoizes, b fails, c never dispatches (concurrency 1).
    const first = await runFlowInline(flow, body, undefined, {
      stubs: {
        'write/b': () => {
          throw new Error('transient');
        },
      },
    });
    expect(first.error).toBeInstanceOf(Error);
    expect(first.snapshot.status).toBe('failed');
    expect(first.snapshot.steps.write.state).toBe('failed');
    expect(first.snapshot.steps.write.current).toBe(1); // only a landed

    // Replay with the first run's memo (the engine's step cache): a is served
    // from memo — its body never re-runs — and only b and c execute.
    const second = await runFlowInline(flow, body, undefined, {
      memo: first.memo,
    });
    expect(second.error).toBeUndefined();
    expect(calls.get('a')).toBe(1); // memoized — never re-ran
    expect(calls.get('b')).toBe(1); // stub threw before the body last time
    expect(calls.get('c')).toBe(1);
    expect(second.trace).toContainEqual(
      expect.objectContaining({ name: 'write/a', cached: true }),
    );
    expect(second.snapshot.steps.write).toMatchObject({
      state: 'complete',
      current: 2, // a's unit report lives in its (memoized, skipped) body —
      // the hub already has that row from the first run; the reducer here is
      // per-run, which is exactly why replays must not re-report.
      total: 3,
    });
  });
});

describe('f.drain', () => {
  const flow = defineFlow({
    name: 'drainer',
    key: () => 'k',
    steps: { pages: units() },
  });

  it('drains until the sentinel; the probe page reports no unit', async () => {
    const run = await runFlowInline(
      flow,
      (f) =>
        f.drain(
          'pages',
          async (page) => (page <= 3 ? `p${page}` : DRAIN_STOP),
          { concurrency: 2 },
        ),
      undefined,
    );
    expect(run.error).toBeUndefined();
    expect(run.output).toEqual(['p1', 'p2', 'p3']); // page order, not completion order
    expect(run.snapshot.steps.pages).toMatchObject({
      state: 'complete',
      current: 3, // the sentinel page was a probe, not work
      total: null, // indeterminate the whole way — done() semantics, not arithmetic
    });
    // The probe page ran as a real engine step.
    expect(run.trace).toContainEqual(
      expect.objectContaining({ type: 'do', name: 'pages/page-4' }),
    );
  });

  it('clamps non-positive concurrency instead of completing empty', async () => {
    const run = await runFlowInline(
      flow,
      (f) =>
        f.drain(
          'pages',
          async (page) => (page <= 2 ? `p${page}` : DRAIN_STOP),
          {
            concurrency: 0,
          },
        ),
      undefined,
    );
    expect(run.error).toBeUndefined();
    expect(run.output).toEqual(['p1', 'p2']);
  });

  it('a worker throw stops dispatch and fails the step', async () => {
    const run = await runFlowInline(
      flow,
      (f) =>
        f.drain(
          'pages',
          async (page) => {
            if (page === 2) throw new Error('boom');
            return page <= 3 ? `p${page}` : DRAIN_STOP;
          },
          { concurrency: 1 },
        ),
      undefined,
    );
    expect(String(run.error)).toMatch(/boom/);
    expect(run.snapshot.steps.pages.state).toBe('failed');
    expect(run.snapshot.status).toBe('failed');
  });
});

describe('f.phase + poll', () => {
  const flow = defineFlow({
    name: 'translator',
    key: () => 'k',
    steps: { translate: phase() },
  });

  it('prefixes engine-step names and settles when the predicate passes', async () => {
    const states = ['PENDING', 'PENDING', 'DONE'];
    const run = await runFlowInline(
      flow,
      (f) =>
        f.phase('translate', async (s) => {
          await s.do('submit', async () => 'batch-1');
          const poll = await s.poll(
            'batch',
            { every: '5 minutes', atMost: 10 },
            async () => states.shift() ?? 'DONE',
            (state) => state === 'DONE',
          );
          return poll;
        }),
      undefined,
    );
    expect(run.output).toEqual({ value: 'DONE', settled: true });
    expect(run.snapshot.steps.translate).toMatchObject({
      state: 'complete',
      current: 1,
      total: 1,
    });
    const names = run.trace.map((t) => `${t.type}:${t.name}`);
    expect(names).toEqual([
      'do:translate/submit',
      'sleep:translate/batch/wait-0',
      'do:translate/batch/check-0',
      'sleep:translate/batch/wait-1',
      'do:translate/batch/check-1',
      'sleep:translate/batch/wait-2',
      'do:translate/batch/check-2',
    ]);
  });

  it('returns settled=false with the last value when the budget runs out', async () => {
    const run = await runFlowInline(
      flow,
      (f) =>
        f.phase('translate', (s) =>
          s.poll(
            'batch',
            { every: '1 minute', atMost: 2 },
            async () => 'PENDING',
            () => false,
          ),
        ),
      undefined,
    );
    expect(run.output).toEqual({ value: 'PENDING', settled: false });
  });
});

describe('f.skip', () => {
  const banner = defineFlow({
    name: 'banner',
    key: () => 'banners',
    steps: { scrape: step(), localize: units(), publish: step() },
  });

  it('stores the intentional skip so completeness holds on early exit', async () => {
    const run = await runFlowInline(
      banner,
      async (f) => {
        const found = await f.step('scrape', async () => 0);
        if (found === 0) {
          f.skip('localize', 'no banners changed');
          f.skip('publish');
          return 'nothing to do';
        }
        return 'unreachable';
      },
      undefined,
    );
    expect(run.snapshot.status).toBe('complete');
    expect(run.snapshot.steps.localize.state).toBe('skipped');
    expect(run.snapshot.steps.publish.state).toBe('skipped');
    expect(run.unfinishedSteps).toEqual([]);
  });
});

describe('f.open', () => {
  const flow = defineFlow({
    name: 'scanner',
    key: () => 'k',
    steps: { scan: units() },
  });

  it('supports keyset loops where map/drain cannot own the counter', async () => {
    const pages = [['a', 'b'], ['c'], []];
    const run = await runFlowInline(
      flow,
      async (f) => {
        const scan = f.open('scan');
        await scan.expect(null);
        const all: string[] = [];
        for (let page = 0; ; page++) {
          const ids = await scan.unit(`page-${page}`, async () => pages[page]);
          if (ids.length === 0) break;
          all.push(...ids);
        }
        await scan.done();
        return all;
      },
      undefined,
    );
    expect(run.output).toEqual(['a', 'b', 'c']);
    expect(run.snapshot.steps.scan).toMatchObject({
      state: 'complete',
      current: 3, // the empty probe page still ran as a unit here — open()
      total: null, //  callers own unit semantics, unlike drain's probe
    });
  });
});

describe('f.open failure', () => {
  const flow = defineFlow({
    name: 'scanner-fail',
    key: () => 'k',
    steps: { scan: units() },
  });

  it('a throwing unit marks the step failed, not forever-running', async () => {
    const run = await runFlowInline(
      flow,
      async (f) => {
        const scan = f.open('scan');
        await scan.expect(null);
        await scan.unit('page-0', async () => {
          throw new Error('scan blew up');
        });
        await scan.done();
      },
      undefined,
    );
    expect(String(run.error)).toMatch(/scan blew up/);
    expect(run.snapshot.status).toBe('failed');
    expect(run.snapshot.steps.scan.state).toBe('failed');
  });
});

describe('join engine-step naming', () => {
  it('two joins on one declared step get distinct, child-scoped names', async () => {
    const child = defineFlow({
      name: 'child',
      key: (p: { item: string }) => p.item,
      steps: { work: step() },
    });
    const parent = defineFlow({
      name: 'serial-parent',
      key: () => 'k',
      steps: { pair: units() },
    });
    // A join port that runs a real engine step through the prefix it's
    // given — mimicking createHubJoinPort's memoized start step.
    const prefixes: string[] = [];
    const run = await runFlowInline(
      parent,
      async (f) => {
        const first = await f.joinSettled('pair', child, { item: 'one' });
        const second = await f.joinSettled('pair', child, { item: 'two' });
        return [first, second];
      },
      undefined,
      {
        joins: {
          join: async (childDef, params, { engine, namePrefix }) => {
            prefixes.push(namePrefix);
            const started = await engine.do(`${namePrefix}start`, async () => ({
              runId: childDef.key(params),
            }));
            return { status: 'complete', output: started.runId };
          },
        },
      },
    );
    expect(run.error).toBeUndefined();
    // Distinct prefixes → the second join's start step is NOT the first's
    // memoized result; each child resolves to its own identity.
    expect(prefixes).toEqual(['pair/child:one/', 'pair/child:two/']);
    expect(run.output).toEqual([
      { status: 'complete', output: 'one' },
      { status: 'complete', output: 'two' },
    ]);
    expect(
      run.trace.filter((t) => t.name.endsWith('/start') && !t.cached),
    ).toHaveLength(2);
  });
});

describe('failure rendering', () => {
  it('trailing pending steps derive not-reached, stored state stays truthful', async () => {
    const run = await runFlowInline(
      linear,
      async (f) => {
        await f.step('fetch', async () => {
          throw new Error('down');
        });
      },
      { id: 'x' },
    );
    const snap = run.snapshot;
    expect(snap.status).toBe('failed');
    const failedIndex = snap.order.findIndex(
      (k) => snap.steps[k].state === 'failed',
    );
    expect(failedIndex).toBe(0);
    // Storage keeps ground truth (pending); the view derives not-reached.
    expect(snap.steps.write.state).toBe('pending');
    expect(segmentView(snap.steps.write, 1, failedIndex)).toBe('not-reached');
    expect(segmentView(snap.steps.publish, 2, failedIndex)).toBe('not-reached');
  });
});

describe('joins', () => {
  const child = defineFlow({
    name: 'image-ingest',
    key: (p: { imageKey: string }) => p.imageKey,
    steps: { mirror: step() },
  });
  const parent = defineFlow({
    name: 'parent',
    key: () => 'k',
    steps: { images: units() },
  });

  const stubJoins = (outcomes: Record<string, unknown>): JoinPort => ({
    join: (childDef, params) => {
      const key = childDef.key(params);
      const out = outcomes[key];
      return Promise.resolve(
        out instanceof Error
          ? { status: 'failed', error: out.message }
          : { status: 'complete', output: out },
      );
    },
  });

  it('mapJoin surfaces child outcomes without throwing (degrade policy)', async () => {
    // mapJoin — NOT joinSettled inside map units: that shape nests engine
    // steps in production and double-reports units (map's + the join's own).
    const run = await runFlowInline(
      parent,
      (f) =>
        f.mapJoin(
          'images',
          async () => ['ok.png', 'bad.png'],
          (img) => joinRequest(child, { imageKey: img }),
          { concurrency: 2, id: (img) => img },
        ),
      undefined,
      {
        joins: stubJoins({
          'ok.png': { mirrored: true },
          'bad.png': new Error('model refused'),
        }),
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.output).toEqual([
      { status: 'complete', output: { mirrored: true } },
      { status: 'failed', error: 'model refused' },
    ]);
    // Both units count as done — a degraded image is settled, not blocking.
    expect(run.snapshot.steps.images).toMatchObject({
      state: 'complete',
      current: 2,
    });
  });

  it('a sole plain join reports its declared step (no pending segment)', async () => {
    const run = await runFlowInline(
      parent,
      async (f) => f.joinSettled('images', child, { imageKey: 'solo.png' }),
      undefined,
      { joins: stubJoins({ 'solo.png': { mirrored: true } }) },
    );
    expect(run.error).toBeUndefined();
    expect(run.snapshot.steps.images).toMatchObject({
      state: 'complete',
      current: 1,
    });
    expect(run.unfinishedSteps).toEqual([]);
  });

  it('join throws FlowJoinError when the child is a prerequisite', async () => {
    const run = await runFlowInline(
      parent,
      async (f) => f.join('images', child, { imageKey: 'bad.png' }),
      undefined,
      { joins: stubJoins({ 'bad.png': new Error('nope') }) },
    );
    expect(run.error).toBeInstanceOf(FlowJoinError);
  });

  it('throws a pointed error without a JoinPort', async () => {
    const run = await runFlowInline(
      parent,
      async (f) => f.join('images', child, { imageKey: 'x' }),
      undefined,
    );
    expect(String(run.error)).toMatch(/requires a JoinPort/);
  });
});
