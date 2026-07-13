/**
 * Type definitions for the workflow worker.
 */

import type { NewsBackfillOutput } from '@hiroba/flows';
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
  /** The news+topics pipeline (ArticleFlow, DQX-25): fetch → extract/tag
   *  events → per-image ingest → translate → per-image localize → purge.
   *  Instances are created only by the FlowHub — triggers go through
   *  hub.start('article'), keyed `${itemType}:${itemId}` so concurrent
   *  triggers attach. */
  ARTICLE_WORKFLOW: WorkflowBinding<ArticleWorkflowParams>;
  /** Eager title translation at discovery (TitleFlow, DQX-11). Instances are
   *  created only by the FlowHub — triggers go through hub.start('title'),
   *  randomly keyed (every discovery batch is disjoint work; starts never
   *  attach). */
  TITLE_WORKFLOW: WorkflowBinding<TitleWorkflowParams>;
  /** Whole-archive title backfill for one language (TitleBackfillFlow,
   *  DQX-13). Instances are created only by the FlowHub — triggers go through
   *  hub.start('title-backfill'), keyed per language so concurrent triggers
   *  attach. */
  TITLE_BACKFILL_WORKFLOW: WorkflowBinding<TitleBackfillWorkflowParams>;
  /** Whole-archive news list scrape (NewsBackfillFlow, DQX-23): drains every
   *  requested category's archive one durable page-unit at a time. Instances
   *  are created only by the FlowHub — triggers go through
   *  hub.start('news-backfill'), keyed by scope (`category ?? 'all'`). */
  NEWS_BACKFILL_WORKFLOW: WorkflowBinding<NewsBackfillWorkflowParams>;
  /** Home-page rotation banners (BannerFlow, DQX-20): scrape → mirror →
   *  transcribe → translate → localize. Instances are created only by the
   *  FlowHub — triggers go through hub.start('banner'). */
  BANNER_WORKFLOW: WorkflowBinding<BannerWorkflowParams>;
  /** Regenerate everything affected by an edited glossary term
   *  (GlossaryRegenFlow, DQX-21): keyset-pages the whole affected set (no
   *  cap). Instances are created only by the FlowHub — triggers go through
   *  hub.start('glossary-regen'), keyed per term. */
  GLOSSARY_REGENERATE_WORKFLOW: WorkflowBinding<GlossaryRegenerateWorkflowParams>;
  /** The playguide pipeline (PlayguideFlow, DQX-24): fetch → per-image ingest
   *  → translate → per-image localize → purge. Instances are created only by
   *  the FlowHub — triggers go through hub.start('playguide'), keyed by slug
   *  so concurrent triggers attach. News/topics stay on ARTICLE_WORKFLOW. */
  PLAYGUIDE_WORKFLOW: WorkflowBinding<PlayguideWorkflowParams>;
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
 * Which pipeline an item flows through — also its event source_type. News and
 * topics share the ArticleFlow (the image steps no-op for image-free news);
 * playguides are static reference pages with no dated events and run their own
 * PlayguideFlow (DQX-24), which never declares the event steps.
 */
export type ItemType = 'news' | 'topic' | 'playguide';

/** The item types that flow through the ArticleFlow. */
export type ArticleItemType = Exclude<ItemType, 'playguide'>;

/**
 * Parameters passed to the ArticleWorkflow (ArticleFlow, DQX-25). `itemType`
 * selects which table the steps read/write, and together with `itemId` it is
 * the hub's dedup key — replacing the old per-item WorkflowManager DO name as
 * the one-run-per-item point.
 */
export type ArticleWorkflowParams = {
  itemId: string;
  itemType: ArticleItemType;
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
 * Parameters passed to the TitleWorkflow: one discovery batch's ids. Titles
 * are read fresh inside the flow, and the target languages come from the
 * enabled-language whitelist (read as a flow step), so nothing else travels.
 */
export type TitleWorkflowParams = {
  itemType: ItemType;
  itemIds: string[];
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
 * Parameters for the NewsBackfillWorkflow (whole-archive list scrape).
 * `category` scopes to one category (all when omitted) — it is also the hub's
 * dedup key (`category ?? 'all'`). Progress reports through the flow tracker
 * to the hub; nothing item-specific is carried.
 */
export type NewsBackfillWorkflowParams = {
  category?: Category;
};

/** Result of the NewsBackfillWorkflow — how much of the archive it scraped.
 *  Declared beside the flow definition so the admin's completion toast and
 *  this producer derive from one shape. */
export type NewsBackfillWorkflowOutput = NewsBackfillOutput;

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

/**
 * Parameters for the PlayguideWorkflow (PlayguideFlow, DQX-24). Just the
 * guide's slug — it is also the hub's dedup key, replacing the old
 * `playguide:<slug>` WorkflowManager DO name as the one-run-per-guide point.
 */
export type PlayguideWorkflowParams = {
  slug: string;
};

/**
 * Overall PlayguideWorkflow output — the ArticleWorkflow shape minus the event
 * steps, which PlayguideFlow never declares (playguides are static reference
 * pages with no dated events).
 */
export type PlayguideWorkflowOutput = {
  slug: string;
  fetchBody: FetchBodyResult;
  mirror: MirrorResult;
  transcribe: TranscribeResult;
  translate: TranslateResult;
  localize: LocalizeResult;
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
  itemType: ArticleItemType;
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
