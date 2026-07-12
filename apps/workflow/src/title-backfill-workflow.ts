/**
 * TitleBackfillWorkflow — the FlowEntrypoint shell for TitleBackfillFlow
 * (DQX-22). The body (and the page-until-no-progress story) lives in
 * title-backfill-flow.ts; this class only binds it to the engine and the hub.
 * Started exclusively via hub.start('title-backfill') — the web list-view
 * trigger and the admin pre-warm — keyed per language, so a backfill already
 * in flight for the language is attached to, never doubled.
 */

import { createDb, resetRunningTitlesForLanguage } from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { FlowEntrypoint } from '@hiroba/flow/hub';
import { TitleBackfillFlow } from '@hiroba/flows';

import { runTitleBackfillFlow } from './title-backfill-flow';
import type {
  Env,
  TitleBackfillWorkflowOutput,
  TitleBackfillWorkflowParams,
} from './types';

export class TitleBackfillWorkflow extends FlowEntrypoint<
  Env,
  typeof TitleBackfillFlow,
  TitleBackfillWorkflowOutput
> {
  readonly def = TitleBackfillFlow;

  flow(
    f: Flow<(typeof TitleBackfillFlow)['steps']>,
    params: TitleBackfillWorkflowParams,
  ): Promise<TitleBackfillWorkflowOutput> {
    return runTitleBackfillFlow(f, params, this.env, this.flowLogger());
  }

  /**
   * A page exhausted its retries — clear any titles left `running` for this
   * language so nothing is stuck mid-flight. Only running rows are touched, so
   * a `done` title keeps its value.
   */
  async onFailure(params: TitleBackfillWorkflowParams): Promise<void> {
    await resetRunningTitlesForLanguage(createDb(this.env.DB), params.language);
  }
}
