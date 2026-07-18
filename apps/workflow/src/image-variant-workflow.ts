/**
 * ImageVariantWorkflow — the FlowEntrypoint shell for ImageVariantFlow. The
 * body lives in image-variant-flow.ts; this class only binds it to the engine
 * and the hub. Started exclusively via hub.start('image-variant') from the
 * admin's manual-upload route, keyed by the render's R2 key.
 */

import type { Flow } from '@hiroba/flow';
import { FlowEntrypoint } from '@hiroba/flow/hub';
import { ImageVariantFlow } from '@hiroba/flows';

import { runImageVariantFlow } from './image-variant-flow';
import type {
  Env,
  ImageVariantWorkflowOutput,
  ImageVariantWorkflowParams,
} from './types';

export class ImageVariantWorkflow extends FlowEntrypoint<
  Env,
  typeof ImageVariantFlow,
  ImageVariantWorkflowOutput
> {
  readonly def = ImageVariantFlow;

  flow(
    f: Flow<(typeof ImageVariantFlow)['steps']>,
    params: ImageVariantWorkflowParams,
  ): Promise<ImageVariantWorkflowOutput> {
    return runImageVariantFlow(f, params, this.env);
  }
}
