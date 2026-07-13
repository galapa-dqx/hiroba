/**
 * PlayguideWorkflow — the FlowEntrypoint shell for PlayguideFlow (DQX-24). The
 * body (and the split-from-ArticleWorkflow story) lives in playguide-flow.ts;
 * this class only binds it to the engine and the hub. Started exclusively via
 * hub.start('playguide') — the admin re-run button, the web detail page's
 * fire-and-forget, the self-healing SSE stream, and the recheck heal — keyed
 * by slug so concurrent triggers attach to the run in flight.
 */

import { createDb, failPipelineStates, getEnabledLanguages } from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { FlowEntrypoint } from '@hiroba/flow/hub';
import { PlayguideFlow } from '@hiroba/flows';

import { runPlayguideFlow } from './playguide-flow';
import type {
  Env,
  PlayguideWorkflowOutput,
  PlayguideWorkflowParams,
} from './types';

export class PlayguideWorkflow extends FlowEntrypoint<
  Env,
  typeof PlayguideFlow,
  PlayguideWorkflowOutput
> {
  readonly def = PlayguideFlow;

  flow(
    f: Flow<(typeof PlayguideFlow)['steps']>,
    params: PlayguideWorkflowParams,
  ): Promise<PlayguideWorkflowOutput> {
    return runPlayguideFlow(f, params, this.env);
  }

  /**
   * Terminal run failure (a step exhausted its retries): settle every pipeline
   * state this guide still holds open so SSE clients and later triggers see
   * failed, not an eternal running. The language set is re-read from the
   * whitelist (the run's memoized read is a step return the cleanup can't
   * see) — a superset mismatch is a no-op per language. Shared image rows
   * settle themselves inside the per-unit step workers.
   */
  async onFailure(
    params: PlayguideWorkflowParams,
    error: unknown,
  ): Promise<void> {
    const db = createDb(this.env.DB);
    const languages = await getEnabledLanguages(db);
    for (const { code } of languages) {
      await failPipelineStates(
        db,
        'playguide',
        params.slug,
        code,
        error instanceof Error ? error.message : 'workflow failed',
      );
    }
  }
}
