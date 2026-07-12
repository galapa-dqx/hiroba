/**
 * TitleWorkflow — the FlowEntrypoint shell for TitleFlow (DQX-22). The body
 * (and the discovery-time story) lives in title-flow.ts; this class only binds
 * it to the engine and the hub. Started exclusively via hub.start('title') —
 * the hourly cron's discovery batches and the admin's list-scrape endpoints —
 * with a RANDOM key: every batch is disjoint work, so starts never attach.
 */

import { createDb, getEnabledLanguages, resetRunningTitles } from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { FlowEntrypoint } from '@hiroba/flow/hub';
import { TitleFlow } from '@hiroba/flows';

import { runTitleFlow } from './title-flow';
import type { Env, TitleWorkflowOutput, TitleWorkflowParams } from './types';

export class TitleWorkflow extends FlowEntrypoint<
  Env,
  typeof TitleFlow,
  TitleWorkflowOutput
> {
  readonly def = TitleFlow;

  flow(
    f: Flow<(typeof TitleFlow)['steps']>,
    params: TitleWorkflowParams,
  ): Promise<TitleWorkflowOutput> {
    return runTitleFlow(f, params, this.env);
  }

  /**
   * A chunk exhausted its retries — reset any of this batch's titles still
   * `running` back to `pending` so nothing is stuck. Only running rows are
   * touched, so already-translated chunks keep their `done`. Swept across the
   * whole whitelist (the run's language set is a step return, not a param):
   * a superset of the languages the run touched, and a no-op for the rest.
   */
  async onFailure(params: TitleWorkflowParams): Promise<void> {
    const db = createDb(this.env.DB);
    for (const language of await getEnabledLanguages(db)) {
      await resetRunningTitles(
        db,
        params.itemType,
        params.itemIds,
        language.code,
      );
    }
  }
}
