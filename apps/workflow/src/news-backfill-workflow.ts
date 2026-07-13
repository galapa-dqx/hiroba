/**
 * NewsBackfillWorkflow — the FlowEntrypoint shell for NewsBackfillFlow
 * (DQX-23). The body (and the drain story) lives in news-backfill-flow.ts;
 * this class only binds it to the engine and the hub. Started exclusively via
 * hub.start('news-backfill') — the admin's "Backfill All" — keyed by the
 * requested scope (`category ?? 'all'`), so re-triggering a scope still in
 * flight attaches instead of duplicating.
 */

import type { Flow } from '@hiroba/flow';
import { FlowEntrypoint } from '@hiroba/flow/hub';
import { NewsBackfillFlow } from '@hiroba/flows';

import { runNewsBackfillFlow } from './news-backfill-flow';
import type {
  Env,
  NewsBackfillWorkflowOutput,
  NewsBackfillWorkflowParams,
} from './types';

export class NewsBackfillWorkflow extends FlowEntrypoint<
  Env,
  typeof NewsBackfillFlow,
  NewsBackfillWorkflowOutput
> {
  readonly def = NewsBackfillFlow;

  flow(
    f: Flow<(typeof NewsBackfillFlow)['steps']>,
    params: NewsBackfillWorkflowParams,
  ): Promise<NewsBackfillWorkflowOutput> {
    return runNewsBackfillFlow(f, params, this.env);
  }
}
