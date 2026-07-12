/**
 * FlowHub integration — real engine, real DO, real SQLite. Each test uses a
 * unique run key, so nothing collides even if instance state bleeds between
 * tests.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { FlowHubApi } from '../src/hub/index';
import type { Snapshot } from '../src/index';

function hub(): FlowHubApi & {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
} {
  const ns = env.FLOW_HUB;
  return ns.get(ns.idFromName('hub')) as unknown as ReturnType<typeof hub>;
}

const uniqueKey = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID()}`;

async function waitFor<T>(
  fn: () => Promise<T>,
  pred: (value: T) => boolean,
  ms = 15_000,
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

describe('start', () => {
  it('dedupes by key: the second start attaches to the active run', async () => {
    const key = uniqueKey('dedup');
    const first = await hub().start('toy-linear', { key });
    const second = await hub().start('toy-linear', { key });
    if (first.throttled || second.throttled) throw new Error('throttled');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);

    const done = await waitFor(
      () => hub().getRun(first.runId),
      (run) => run?.status === 'complete',
    );
    expect(done?.output).toEqual({ joined: 'A,B,C' });

    // The run settled — a third start creates a fresh run.
    const third = await hub().start('toy-linear', { key });
    if (third.throttled) throw new Error('throttled');
    expect(third.created).toBe(true);
    expect(third.runId).not.toBe(first.runId);
  });

  it('throttles repeat starts within the cooldown; force bypasses', async () => {
    const key = uniqueKey('throttle');
    const first = await hub().start('toy-linear', { key });
    if (first.throttled) throw new Error('throttled');
    await waitFor(
      () => hub().getRun(first.runId),
      (run) => run?.status === 'complete',
    );

    const throttled = await hub().start(
      'toy-linear',
      { key },
      { cooldownMs: 60_000 },
    );
    expect(throttled).toEqual({ throttled: true });

    const forced = await hub().start(
      'toy-linear',
      { key },
      { cooldownMs: 60_000, force: true },
    );
    if (forced.throttled) throw new Error('throttled');
    expect(forced.created).toBe(true);
  });

  it('answers null snapshots for unknown flows and keys', async () => {
    // start() on an unregistered flow throws DO-side (a programming error
    // caught on first dev run); asserting the throw over RPC leaves vitest
    // unhandled-rejection noise, so the read path covers the lookup instead.
    expect(await hub().getSnapshot({ flow: 'nope', key: 'x' })).toBeNull();
    expect(await hub().getSnapshot({ runId: 'no-such-run' })).toBeNull();
  });
});

describe('snapshots', () => {
  it('seeds every declared step pending at creation, then tracks to complete', async () => {
    const key = uniqueKey('seed');
    const res = await hub().start('toy-linear', { key });
    if (res.throttled) throw new Error('throttled');

    // Immediately after start the full segment map is already paintable.
    const seeded = await hub().getSnapshot({ runId: res.runId });
    expect(seeded?.order).toEqual(['prep', 'work', 'finish']);
    expect(seeded?.steps.work.total).toBeNull(); // units → indeterminate

    const finished = await waitFor(
      () => hub().getSnapshot({ runId: res.runId }),
      (snap) => snap?.status === 'complete',
    );
    expect(finished?.steps.prep).toMatchObject({
      state: 'complete',
      current: 1,
      total: 1,
    });
    expect(finished?.steps.work).toMatchObject({
      state: 'complete',
      current: 3,
      total: 3,
    });
    expect(finished?.seq).toBeGreaterThan(0);
  });

  it('a failed unit fails the run; trailing steps stay honestly pending', async () => {
    const key = uniqueKey('fail');
    const res = await hub().start('toy-linear', { key, failWork: true });
    if (res.throttled) throw new Error('throttled');

    const snap = await waitFor(
      () => hub().getSnapshot({ runId: res.runId }),
      (s) => s?.status === 'failed',
    );
    expect(snap?.steps.work.state).toBe('failed');
    expect(snap?.steps.finish.state).toBe('pending'); // view derives not-reached
    expect(snap?.error).toMatch(/unit b exploded/);
    // Units a and c completed and stay counted — no rollback of facts.
    expect(snap?.steps.work.current).toBeGreaterThanOrEqual(1);
  });

  it('stored skips satisfy the completeness check', async () => {
    const key = uniqueKey('skip');
    const res = await hub().start('toy-linear', { key, skipFinish: true });
    if (res.throttled) throw new Error('throttled');
    const snap = await waitFor(
      () => hub().getSnapshot({ runId: res.runId }),
      (s) => s?.status === 'complete',
    );
    expect(snap?.steps.finish.state).toBe('skipped');
  });

  it('a forgotten step leaves a pending segment on a complete run (the bait)', async () => {
    const key = uniqueKey('forgot');
    const res = await hub().start('toy-linear', { key, forgetFinish: true });
    if (res.throttled) throw new Error('throttled');
    const snap = await waitFor(
      () => hub().getSnapshot({ runId: res.runId }),
      (s) => s?.status === 'complete',
    );
    // The hub logs this loudly (warnUnfinished); the observable contract is
    // the honest snapshot: complete run, pending step.
    expect(snap?.steps.finish.state).toBe('pending');
  });

  it('resolves the latest run for a (flow, key) pair', async () => {
    const key = uniqueKey('latest');
    const res = await hub().start('toy-linear', { key });
    if (res.throttled) throw new Error('throttled');
    const snap = await hub().getSnapshot({ flow: 'toy-linear', key });
    expect(snap?.runId).toBe(res.runId);
  });
});

describe('SSE', () => {
  it('streams the current snapshot immediately and closes on terminal', async () => {
    const key = uniqueKey('sse');
    const res = await hub().start('toy-linear', { key });
    if (res.throttled) throw new Error('throttled');

    const response = await hub().fetch(`https://hub/sse?runId=${res.runId}`);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames: Snapshot[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (chunk.startsWith('data: ')) {
          frames.push(JSON.parse(chunk.slice(6)) as Snapshot);
        }
      }
    }

    expect(frames.length).toBeGreaterThan(0);
    // seq strictly increases — stale frames are dropped hub-side.
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].seq).toBeGreaterThan(frames[i - 1].seq);
    }
    expect(frames.at(-1)?.status).toBe('complete');
    expect(frames.at(-1)?.steps.work.current).toBe(3);
  });

  it('404s for an unknown run', async () => {
    const response = await hub().fetch('https://hub/sse?runId=nope');
    expect(response.status).toBe(404);
  });
});

describe('listRuns', () => {
  it('lists newest-first with terminal statuses', async () => {
    const key = uniqueKey('list');
    const res = await hub().start('toy-linear', { key });
    if (res.throttled) throw new Error('throttled');
    await waitFor(
      () => hub().getRun(res.runId),
      (run) => run?.status === 'complete',
    );
    const runs = await hub().listRuns({ flow: 'toy-linear', limit: 50 });
    const mine = runs.find((run) => run.runId === res.runId);
    expect(mine).toMatchObject({ key, status: 'complete' });
  });

  it('serves the same listing over fetch /runs (for fetch-only callers)', async () => {
    const key = uniqueKey('list-fetch');
    const res = await hub().start('toy-linear', { key });
    if (res.throttled) throw new Error('throttled');
    await waitFor(
      () => hub().getRun(res.runId),
      (run) => run?.status === 'complete',
    );
    const response = await hub().fetch(
      'https://hub/runs?flow=toy-linear&limit=50',
    );
    expect(response.status).toBe(200);
    const { runs } = (await response.json()) as {
      runs: Array<{ runId: string; key: string; status: string }>;
    };
    const mine = runs.find((run) => run.runId === res.runId);
    expect(mine).toMatchObject({ key, status: 'complete' });
  });
});
