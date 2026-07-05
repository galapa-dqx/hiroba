/**
 * Type definitions for the workflow worker.
 */

import type { LocalizeResult } from './steps/localize-images';
import type { MirrorResult } from './steps/mirror-images';

/**
 * Workflow instance type for type safety.
 */
export type WorkflowInstance = {
  id: string;
  status(): Promise<{
    status:
      | 'queued'
      | 'running'
      | 'paused'
      | 'complete'
      | 'errored'
      | 'terminated'
      | 'unknown';
    output?: unknown;
    error?: string;
  }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
  restart(): Promise<void>;
};

/**
 * Workflow binding type.
 */
export type WorkflowBinding<T = unknown> = {
  create(options?: { id?: string; params?: T }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
};

/**
 * Environment bindings for the workflow worker.
 */
export type Env = {
  DB: D1Database;
  /** R2 bucket mirroring topic images. */
  IMAGES_BUCKET: R2Bucket;
  /** Cloudflare Images binding — transcode/normalize before gpt-image-2. */
  IMAGES: ImagesBinding;
  OPENAI_API_KEY: string;
  GEMINI_API_KEY: string;
  SENTRY_DSN: string;
  WORKFLOW_MANAGER: DurableObjectNamespace;
  NEWS_WORKFLOW: WorkflowBinding<NewsWorkflowParams>;
  TOPICS_WORKFLOW: WorkflowBinding<TopicsWorkflowParams>;
  CF_VERSION_METADATA: { id: string };
};

/** Which pipeline a WorkflowManager DO coordinates. */
export type ItemType = 'news' | 'topic';

/**
 * Parameters passed to the NewsWorkflow.
 */
export type NewsWorkflowParams = {
  itemId: string;
};

/**
 * Result of the fetch-body step.
 */
export type FetchBodyResult = {
  success: boolean;
  contentLength?: number;
};

/**
 * Result of the extract-events step.
 */
export type ExtractEventsResult = {
  count: number;
  eventIds: string[];
};

/**
 * Result of the translate step.
 */
export type TranslateResult = {
  success: boolean;
  fieldsTranslated: number;
};

/**
 * Overall workflow output.
 */
export type NewsWorkflowOutput = {
  itemId: string;
  fetchBody: FetchBodyResult;
  extractEvents: ExtractEventsResult;
  translate: TranslateResult;
};

/**
 * Parameters passed to the TopicsWorkflow.
 */
export type TopicsWorkflowParams = {
  itemId: string;
};

/** Result of the topics fetch-body step (scrape + parse → blocks_ja). */
export type FetchTopicResult = {
  success: boolean;
  blockCount: number;
};

/** Result of the transcribe-images step. */
export type TranscribeResult = {
  imagesTranscribed: number;
};

/**
 * Overall TopicsWorkflow output. The presence of successive keys drives SSE
 * progress messages (fetch → mirror → transcribe → translate → localize).
 */
export type TopicsWorkflowOutput = {
  itemId: string;
  fetchBody: FetchTopicResult;
  mirror: MirrorResult;
  transcribe: TranscribeResult;
  translate: TranslateResult;
  localize: LocalizeResult;
};

/**
 * SSE event types for workflow progress.
 */
export type SSEEvent =
  | { type: 'progress'; message: string }
  | { type: 'complete' }
  | { type: 'error'; error: string };
