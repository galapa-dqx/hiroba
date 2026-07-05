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
  /** R2 bucket mirroring article images. */
  IMAGES_BUCKET: R2Bucket;
  /** Cloudflare Images binding — transcode/normalize before gpt-image-2. */
  IMAGES: ImagesBinding;
  OPENAI_API_KEY: string;
  GEMINI_API_KEY: string;
  SENTRY_DSN: string;
  WORKFLOW_MANAGER: DurableObjectNamespace;
  /** The unified news+topics pipeline (item type carried in the params). */
  ARTICLE_WORKFLOW: WorkflowBinding<ArticleWorkflowParams>;
  /** Eager title translation at discovery (DQX-11); backfill-ready (DQX-13). */
  TITLE_WORKFLOW: WorkflowBinding<TitleWorkflowParams>;
  CF_VERSION_METADATA: { id: string };
  /** Log verbosity: debug | info | warn | error | silent (default info). */
  LOG_LEVEL?: string;
};

/** Which pipeline an item flows through — also its event source_type. */
export type ItemType = 'news' | 'topic';

/**
 * Parameters passed to the ArticleWorkflow. `itemType` selects which table the
 * steps read/write; the two never collide (the DO is namespaced per type).
 */
export type ArticleWorkflowParams = {
  itemId: string;
  itemType: ItemType;
};

/**
 * Parameters passed to the TitleWorkflow. Carries only ids (titles are read
 * fresh inside the workflow) and the languages to translate into. Discovery
 * passes a run's new ids; the DQX-13 backfill will pass an untranslated slice.
 */
export type TitleWorkflowParams = {
  itemType: ItemType;
  itemIds: string[];
  languages: string[];
};

/** Result of the TitleWorkflow — titles written to `done` vs deferred. */
export type TitleWorkflowOutput = {
  itemType: ItemType;
  translated: number;
  failed: number;
};

/** Result of the fetch-body step (scrape + parse → blocks_ja). */
export type FetchBodyResult = {
  success: boolean;
  blockCount: number;
};

/**
 * Result of the extract-events step.
 */
export type ExtractEventsResult = {
  count: number;
  eventIds: string[];
};

/**
 * Result of the tag-events step (best-effort time/event annotation of
 * blocks_ja). `tagged: false` means both attempts failed validation and the
 * tree was left (or reset to) untagged.
 */
export type TagEventsResult = {
  tagged: boolean;
  timeTags: number;
  eventTags: number;
  retried: boolean;
};

/** Result of the transcribe-images step. */
export type TranscribeResult = {
  imagesTranscribed: number;
};

/**
 * Result of the translate step.
 */
export type TranslateResult = {
  success: boolean;
  fieldsTranslated: number;
};

/**
 * Overall ArticleWorkflow output. The presence of successive keys tracks
 * progress (fetch → extract → mirror → transcribe → translate → localize); the
 * image steps report zero totals for image-free items (news).
 */
export type ArticleWorkflowOutput = {
  itemId: string;
  itemType: ItemType;
  fetchBody: FetchBodyResult;
  extractEvents: ExtractEventsResult;
  tagEvents: TagEventsResult;
  mirror: MirrorResult;
  transcribe: TranscribeResult;
  translate: TranslateResult;
  localize: LocalizeResult;
};

// The SSE wire protocol (machine-readable state snapshots) is shared with the
// web/admin clients — see @hiroba/shared's pipeline-state module.
export type { SSEEvent, StateSnapshot } from '@hiroba/shared';
