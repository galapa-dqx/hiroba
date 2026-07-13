/**
 * ArticleWorkflow — the FlowEntrypoint shell for ArticleFlow (DQX-25). The
 * body (and the shared-fragment story) lives in article-flow.ts; this class
 * only binds it to the engine and the hub. Started exclusively via
 * hub.start('article') — the web detail page's fire-and-forget, the admin
 * re-run buttons, the self-healing SSE stream, the recheck heal, and the
 * glossary-regen fan-out — keyed `${itemType}:${itemId}` so concurrent
 * triggers attach to the run in flight.
 */

import { createDb, failPipelineStates, getEnabledLanguages } from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { FlowEntrypoint } from '@hiroba/flow/hub';
import { ArticleFlow } from '@hiroba/flows';

import { runArticleFlow } from './article-flow';
import type {
  ArticleWorkflowOutput,
  ArticleWorkflowParams,
  Env,
} from './types';

export class ArticleWorkflow extends FlowEntrypoint<
  Env,
  typeof ArticleFlow,
  ArticleWorkflowOutput
> {
  readonly def = ArticleFlow;

  flow(
    f: Flow<(typeof ArticleFlow)['steps']>,
    params: ArticleWorkflowParams,
  ): Promise<ArticleWorkflowOutput> {
    return runArticleFlow(f, params, this.env);
  }

  /**
   * Terminal run failure (a step exhausted its retries): settle every pipeline
   * state this item still holds open so SSE clients and later triggers see
   * failed, not an eternal running — the old workflow's `mark-failed` step,
   * now the framework's failure hook. The language set is re-read from the
   * whitelist (the run's memoized read is a step return the cleanup can't
   * see) — a superset mismatch is a no-op per language. Shared image rows
   * settle themselves inside the per-unit step workers.
   */
  async onFailure(
    params: ArticleWorkflowParams,
    error: unknown,
  ): Promise<void> {
    const db = createDb(this.env.DB);
    const languages = await getEnabledLanguages(db);
    for (const { code } of languages) {
      await failPipelineStates(
        db,
        params.itemType,
        params.itemId,
        code,
        error instanceof Error ? error.message : 'workflow failed',
      );
    }
  }
}
