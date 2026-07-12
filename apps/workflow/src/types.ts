/**
 * Type definitions for the workflow worker.
 */

import type { Category } from '@hiroba/shared';

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
  /** The flow framework's control plane — one 'hub' instance, one SQLite
   *  database for all runs/steps/units state (src/flow-hub.ts). */
  FLOW_HUB: DurableObjectNamespace;
  /** The unified news+topics pipeline (item type carried in the params). */
  ARTICLE_WORKFLOW: WorkflowBinding<ArticleWorkflowParams>;
  /** Eager title translation at discovery (DQX-11). */
  TITLE_WORKFLOW: WorkflowBinding<TitleWorkflowParams>;
  /** Whole-archive title backfill for one language (DQX-13). */
  TITLE_BACKFILL_WORKFLOW: WorkflowBinding<TitleBackfillWorkflowParams>;
  /** Whole-archive news list scrape — pages the archive one durable step at a
   *  time so it isn't bound by a single request's subrequest limit (DQX-14). */
  NEWS_BACKFILL_WORKFLOW: WorkflowBinding<NewsBackfillWorkflowParams>;
  /** Home-page rotation banners (BannerFlow, DQX-20): scrape → mirror →
   *  transcribe → translate → localize. Instances are created only by the
   *  FlowHub — triggers go through hub.start('banner'). */
  BANNER_WORKFLOW: WorkflowBinding<BannerWorkflowParams>;
  /** Regenerate every article whose body contains an edited glossary term —
   *  pages the whole affected set one durable step at a time (no cap). */
  GLOSSARY_REGENERATE_WORKFLOW: WorkflowBinding<GlossaryRegenerateWorkflowParams>;
  CF_VERSION_METADATA: { id: string };
  /** Log verbosity: debug | info | warn | error | silent (default info). */
  LOG_LEVEL?: string;
  /**
   * Edge-cache purge config (see src/purge.ts). All optional — purge no-ops
   * until they're set, so the pipeline runs unchanged without them.
   */
  CF_ZONE_ID?: string;
  /** API token with the Zone → Cache Purge permission (a secret). */
  CF_PURGE_TOKEN?: string;
  /** Public origin of the web app, for building article URLs to purge. */
  WEB_BASE_URL?: string;
  /** Public host of the R2 image bucket, for building image URLs to purge. */
  IMAGE_BASE?: string;
};

/**
 * Which pipeline an item flows through — also its event source_type. All three
 * share the ArticleWorkflow; playguides are static reference pages (no dated
 * events, so the event steps are skipped) that otherwise run the full
 * scrape→translate→localize-images pipeline like topics.
 */
export type ItemType = 'news' | 'topic' | 'playguide';

/**
 * Parameters passed to the ArticleWorkflow. `itemType` selects which table the
 * steps read/write; the two never collide (the DO is namespaced per type).
 */
export type ArticleWorkflowParams = {
  itemId: string;
  itemType: ItemType;
};

/** The BannerWorkflow scrapes + localizes the whole rotation; no params. */
export type BannerWorkflowParams = Record<string, never>;

/** Result of the BannerWorkflow — counts across the rotation. */
export type BannerWorkflowOutput = {
  banners: number;
  mirrored: number;
  transcribed: number;
  localized: number;
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

/**
 * Parameters passed to the TitleBackfillWorkflow (DQX-13). Just the target
 * language: the workflow scans D1 for that language's untranslated titles
 * itself (news + topics), so nothing item-specific is carried.
 */
export type TitleBackfillWorkflowParams = {
  language: string;
};

/** Result of the TitleBackfillWorkflow — how much of the archive it swept. */
export type TitleBackfillWorkflowOutput = {
  language: string;
  scanned: number;
  translated: number;
  failed: number;
};

/**
 * Parameters for the NewsBackfillWorkflow (whole-archive list scrape, DQX-14).
 * `category` scopes to one category (all when omitted). `streamKey` is the
 * WorkflowManager DO instance name the caller reached — the workflow reports
 * per-page progress back to it so the SSE stream can show a live bar.
 */
export type NewsBackfillWorkflowParams = {
  category?: Category;
  streamKey: string;
};

/** Result of the NewsBackfillWorkflow — how much of the archive it scraped. */
export type NewsBackfillWorkflowOutput = {
  pages: number;
  scraped: number;
  newItems: number;
};

/**
 * Parameters for the GlossaryRegenerateWorkflow. Just the Japanese term whose
 * translation changed: the workflow scans D1 for every article whose body
 * contains it (re-running each one's ArticleWorkflow) and every image whose
 * baked-in text contains it (refreshing its stored `text` translation).
 */
export type GlossaryRegenerateWorkflowParams = {
  sourceText: string;
};

/**
 * Result of the GlossaryRegenerateWorkflow — how many articles it re-triggered
 * and how many image `text` translations it refreshed (the localized raster is
 * left as-is; only the stored text changes).
 */
export type GlossaryRegenerateWorkflowOutput = {
  sourceText: string;
  triggered: number;
  imagesRetranslated: number;
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
