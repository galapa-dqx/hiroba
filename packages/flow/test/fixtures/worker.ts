/**
 * Toy flows for the integration tier — test the framework, not the migration.
 * Every tracker primitive and hub path gets exercised by one of these before
 * any real workflow ports onto the framework.
 */

import {
  createFlowHub,
  FlowEntrypoint,
  type FlowHubEnv,
} from '../../src/hub/index';
import {
  defineFlow,
  joinRequest,
  step,
  units,
  type EngineStepConfig,
  type Flow,
} from '../../src/index';

export type TestEnv = {
  TOY_LINEAR: unknown;
  TOY_CHILD: unknown;
  TOY_PARENT: unknown;
  TOY_SERIAL: unknown;
} & FlowHubEnv;

/** Tests exercise real engine retries — keep them short, not absent. */
const FAST_STEPS: EngineStepConfig = {
  retries: { limit: 1, delay: '1 second', backoff: 'constant' },
  timeout: '30 seconds',
};

// -----------------------------------------------------------------------------
// toy-linear — step, map, skip, failure, completeness bait
// -----------------------------------------------------------------------------

export type LinearParams = {
  key: string;
  failWork?: boolean;
  skipFinish?: boolean;
  forgetFinish?: boolean;
};

export const ToyLinearFlow = defineFlow({
  name: 'toy-linear',
  key: (p: LinearParams) => p.key,
  steps: { prep: step(), work: units(), finish: step() },
});

export class ToyLinearWorkflow extends FlowEntrypoint<
  TestEnv,
  typeof ToyLinearFlow
> {
  readonly def = ToyLinearFlow;
  protected override stepDefaults = FAST_STEPS;

  async flow(f: Flow<(typeof ToyLinearFlow)['steps']>, params: LinearParams) {
    await f.step('prep', async () => 'ready');
    const out = await f.map(
      'work',
      async () => ['a', 'b', 'c'],
      async (x) => {
        if (params.failWork && x === 'b') throw new Error('unit b exploded');
        return x.toUpperCase();
      },
      { concurrency: 2, id: (x) => x },
    );
    if (params.skipFinish) {
      f.skip('finish', 'nothing to finish');
      return { joined: null };
    }
    if (params.forgetFinish) {
      // Deliberately neither runs nor skips `finish` — the hub's completeness
      // check should flag this run.
      return { joined: null };
    }
    const joined = await f.step('finish', async () => out.join(','));
    return { joined };
  }
}

// -----------------------------------------------------------------------------
// toy-child / toy-parent — joins: dedup by child key, terminal notification
// -----------------------------------------------------------------------------

export type ChildParams = {
  item: string;
  fail?: boolean;
  sleepMs?: number;
};

export const ToyChildFlow = defineFlow({
  name: 'toy-child',
  key: (p: ChildParams) => p.item,
  steps: { work: step() },
});

export class ToyChildWorkflow extends FlowEntrypoint<
  TestEnv,
  typeof ToyChildFlow
> {
  readonly def = ToyChildFlow;
  protected override stepDefaults = FAST_STEPS;

  async flow(f: Flow<(typeof ToyChildFlow)['steps']>, params: ChildParams) {
    const made = await f.step('work', async () => {
      if (params.sleepMs) {
        await new Promise((resolve) => setTimeout(resolve, params.sleepMs));
      }
      if (params.fail) throw new Error(`child ${params.item} failed`);
      return `made:${params.item}`;
    });
    return { made };
  }
}

export type ParentParams = {
  key: string;
  items: ChildParams[];
};

export const ToyParentFlow = defineFlow({
  name: 'toy-parent',
  key: (p: ParentParams) => p.key,
  steps: { fanout: units() },
});

export class ToyParentWorkflow extends FlowEntrypoint<
  TestEnv,
  typeof ToyParentFlow
> {
  readonly def = ToyParentFlow;
  protected override stepDefaults = FAST_STEPS;

  async flow(f: Flow<(typeof ToyParentFlow)['steps']>, params: ParentParams) {
    const outcomes = await f.mapJoin(
      'fanout',
      async () => params.items,
      (item) => joinRequest(ToyChildFlow, item),
      { concurrency: 2, id: (item) => item.item },
    );
    return { outcomes };
  }
}

// -----------------------------------------------------------------------------
// toy-serial — two plain joins on ONE declared step (regression: join engine
// steps must be named per child, or the second join replays the first's memo)
// -----------------------------------------------------------------------------

export type SerialParams = {
  key: string;
  itemA: string;
  itemB: string;
};

export const ToySerialFlow = defineFlow({
  name: 'toy-serial',
  key: (p: SerialParams) => p.key,
  steps: { pair: units() },
});

export class ToySerialWorkflow extends FlowEntrypoint<
  TestEnv,
  typeof ToySerialFlow
> {
  readonly def = ToySerialFlow;
  protected override stepDefaults = FAST_STEPS;

  async flow(f: Flow<(typeof ToySerialFlow)['steps']>, params: SerialParams) {
    const pair = f.open('pair');
    await pair.expect(2);
    const first = await f.joinSettled('pair', ToyChildFlow, {
      item: params.itemA,
    });
    await pair.unit(params.itemA, async () => first.status);
    const second = await f.joinSettled('pair', ToyChildFlow, {
      item: params.itemB,
    });
    await pair.unit(params.itemB, async () => second.status);
    await pair.done();
    return { statuses: [first.status, second.status] };
  }
}

// -----------------------------------------------------------------------------
// hub + worker entry
// -----------------------------------------------------------------------------

export class FlowHub extends createFlowHub([
  { def: ToyLinearFlow, binding: 'TOY_LINEAR' },
  { def: ToyChildFlow, binding: 'TOY_CHILD' },
  { def: ToyParentFlow, binding: 'TOY_PARENT' },
  { def: ToySerialFlow, binding: 'TOY_SERIAL' },
]) {}

export default {
  fetch: (): Response => new Response('flow-test fixture worker'),
};
