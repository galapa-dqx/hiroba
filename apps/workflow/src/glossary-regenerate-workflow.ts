/**
 * GlossaryRegenerateWorkflow — the FlowEntrypoint shell for GlossaryRegenFlow
 * (DQX-21). The body (and the pass-by-pass story) lives in
 * glossary-regen-flow.ts; this class only binds it to the engine and the hub.
 * Started exclusively via hub.start('glossary-regen') — the admin's
 * glossary/regenerate endpoint — with the term as the dedup key, so
 * re-triggering a running regeneration attaches instead of duplicating.
 */

import type { Flow } from '@hiroba/flow';
import { FlowEntrypoint } from '@hiroba/flow/hub';
import { GlossaryRegenFlow } from '@hiroba/flows';

import { runGlossaryRegenFlow } from './glossary-regen-flow';
import type {
  Env,
  GlossaryRegenerateWorkflowOutput,
  GlossaryRegenerateWorkflowParams,
} from './types';

export class GlossaryRegenerateWorkflow extends FlowEntrypoint<
  Env,
  typeof GlossaryRegenFlow,
  GlossaryRegenerateWorkflowOutput
> {
  readonly def = GlossaryRegenFlow;

  flow(
    f: Flow<(typeof GlossaryRegenFlow)['steps']>,
    params: GlossaryRegenerateWorkflowParams,
  ): Promise<GlossaryRegenerateWorkflowOutput> {
    return runGlossaryRegenFlow(f, params, this.env);
  }
}
