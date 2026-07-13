/**
 * ImageLocalizeWorkflow — the FlowEntrypoint shell for ImageLocalizeFlow
 * (DQX-27). The body lives in image-localize-flow.ts; this class only binds
 * it to the engine and the hub. Started exclusively via the hub by parent
 * flows' `mapJoin`s after their translate phase, keyed `${imageKey}:${lang}`
 * so every article sharing the image attaches to one generation.
 *
 * No onFailure hook: the image's `url` translation row is settled inside
 * `localizeImageLanguage` itself (it marks failed and returns rather than
 * throw), exactly as it was when this work ran inline in the article pipeline.
 */

import type { Flow } from '@hiroba/flow';
import { FlowEntrypoint } from '@hiroba/flow/hub';
import { ImageLocalizeFlow } from '@hiroba/flows';

import { runImageLocalizeFlow } from './image-localize-flow';
import type {
  Env,
  ImageLocalizeWorkflowOutput,
  ImageLocalizeWorkflowParams,
} from './types';

export class ImageLocalizeWorkflow extends FlowEntrypoint<
  Env,
  typeof ImageLocalizeFlow,
  ImageLocalizeWorkflowOutput
> {
  readonly def = ImageLocalizeFlow;

  flow(
    f: Flow<(typeof ImageLocalizeFlow)['steps']>,
    params: ImageLocalizeWorkflowParams,
  ): Promise<ImageLocalizeWorkflowOutput> {
    return runImageLocalizeFlow(f, params, this.env);
  }
}
