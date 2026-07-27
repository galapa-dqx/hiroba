/**
 * ImageFileWorkflow — the FlowEntrypoint shell for ImageFileFlow. The body
 * lives in image-file-flow.ts; this class only binds it to the engine and the
 * hub. Started exclusively via hub.start('image-file') from the admin's
 * manual-upload route, keyed by the render's image id.
 */

import type { Flow } from '@hiroba/flow';
import { FlowEntrypoint } from '@hiroba/flow/hub';
import { ImageFileFlow } from '@hiroba/flows';

import { runImageFileFlow } from './image-file-flow';
import type {
  Env,
  ImageFileWorkflowOutput,
  ImageFileWorkflowParams,
} from './types';

export class ImageFileWorkflow extends FlowEntrypoint<
  Env,
  typeof ImageFileFlow,
  ImageFileWorkflowOutput
> {
  readonly def = ImageFileFlow;

  flow(
    f: Flow<(typeof ImageFileFlow)['steps']>,
    params: ImageFileWorkflowParams,
  ): Promise<ImageFileWorkflowOutput> {
    return runImageFileFlow(f, params, this.env);
  }
}
