/**
 * BannerWorkflow — the FlowEntrypoint shell for BannerFlow (DQX-20). The body
 * (and the step-by-step story) lives in banner-flow.ts; this class only binds
 * it to the engine and the hub. Started exclusively via hub.start('banner'):
 * the hourly cron (src/index.ts) and the admin's banners/refresh endpoint.
 */

import type { Flow } from '@hiroba/flow';
import { FlowEntrypoint } from '@hiroba/flow/hub';
import { BannerFlow } from '@hiroba/flows';

import { runBannerFlow } from './banner-flow';
import type { BannerWorkflowOutput, Env } from './types';

export class BannerWorkflow extends FlowEntrypoint<
  Env,
  typeof BannerFlow,
  BannerWorkflowOutput
> {
  readonly def = BannerFlow;

  flow(f: Flow<(typeof BannerFlow)['steps']>): Promise<BannerWorkflowOutput> {
    return runBannerFlow(f, this.env);
  }
}
