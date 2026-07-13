/**
 * @hiroba/flows — hiroba's flow DEFINITIONS, and nothing else.
 *
 * Thin on purpose (docs/flow-framework.md §package layout): a definition is
 * name + dedup key + step shape, importable by apps/admin for typed snapshots
 * without dragging in step code. Flow bodies and step functions stay in
 * apps/workflow; the def-name → workflow-binding map lives where the hub is
 * mounted (apps/workflow/src/flow-hub.ts).
 */

export { ArticleFlow } from './article';
export { BannerFlow } from './banner';
export { articleImagework, articleIntake, articleOutput } from './fragments';
export { GlossaryRegenFlow } from './glossary-regen';
export { ImageIngestFlow } from './image-ingest';
export { ImageLocalizeFlow } from './image-localize';
export { NewsBackfillFlow, type NewsBackfillOutput } from './news-backfill';
export { PlayguideFlow } from './playguide';
export {
  DEFAULT_ITEM_RUN_STRINGS,
  describeItemRun,
  itemFlowKey,
  itemFlowStart,
  itemRunHealth,
  type ItemFlowType,
  type ItemRunHealth,
  type ItemRunLike,
  type ItemRunStrings,
} from './progress';
export { TitleBackfillFlow, TitleFlow } from './titles';
