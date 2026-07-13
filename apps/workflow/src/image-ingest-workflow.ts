/**
 * ImageIngestWorkflow — the FlowEntrypoint shell for ImageIngestFlow (DQX-27).
 * The body lives in image-ingest-flow.ts; this class only binds it to the
 * engine and the hub. Started exclusively via the hub by parent flows'
 * `mapJoin`s (article, playguide), keyed by the image key so every parent
 * referencing the same image attaches to one run.
 *
 * No onFailure hook: the shared `images` rows are settled inside the step
 * workers themselves (they mark failed and return rather than throw), exactly
 * as they were when this work ran inline in the article pipeline.
 */

import type { Flow } from '@hiroba/flow';
import { FlowEntrypoint } from '@hiroba/flow/hub';
import { ImageIngestFlow } from '@hiroba/flows';

import { runImageIngestFlow } from './image-ingest-flow';
import type {
  Env,
  ImageIngestWorkflowOutput,
  ImageIngestWorkflowParams,
} from './types';

export class ImageIngestWorkflow extends FlowEntrypoint<
  Env,
  typeof ImageIngestFlow,
  ImageIngestWorkflowOutput
> {
  readonly def = ImageIngestFlow;

  flow(
    f: Flow<(typeof ImageIngestFlow)['steps']>,
    params: ImageIngestWorkflowParams,
  ): Promise<ImageIngestWorkflowOutput> {
    return runImageIngestFlow(f, params, this.env);
  }
}
