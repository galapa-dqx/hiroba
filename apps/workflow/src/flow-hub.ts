/**
 * The FlowHub mount for this worker (DQX-19).
 *
 * The registration list below is the ONE def-name → workflow-binding map in
 * the system (docs/flow-framework.md) — each port PR (DQX-20+) adds its flow
 * here and nowhere else.
 */

import {
  createFlowHub,
  type FlowHubClass,
  type FlowRegistration,
} from '@hiroba/flow/hub';
import {
  ArticleFlow,
  BannerFlow,
  GlossaryRegenFlow,
  ImageIngestFlow,
  ImageLocalizeFlow,
  NewsBackfillFlow,
  PlayguideFlow,
  TitleBackfillFlow,
  TitleFlow,
} from '@hiroba/flows';

const registrations: FlowRegistration[] = [
  { def: ArticleFlow, binding: 'ARTICLE_WORKFLOW' },
  { def: BannerFlow, binding: 'BANNER_WORKFLOW' },
  { def: GlossaryRegenFlow, binding: 'GLOSSARY_REGENERATE_WORKFLOW' },
  { def: TitleFlow, binding: 'TITLE_WORKFLOW' },
  { def: TitleBackfillFlow, binding: 'TITLE_BACKFILL_WORKFLOW' },
  { def: NewsBackfillFlow, binding: 'NEWS_BACKFILL_WORKFLOW' },
  { def: PlayguideFlow, binding: 'PLAYGUIDE_WORKFLOW' },
  { def: ImageIngestFlow, binding: 'IMAGE_INGEST_WORKFLOW' },
  { def: ImageLocalizeFlow, binding: 'IMAGE_LOCALIZE_WORKFLOW' },
];

// Annotated so the exported class type doesn't reference the factory's
// anonymous class expression (TS2742).
const HubBase: FlowHubClass = createFlowHub(registrations);

export class FlowHub extends HubBase {}
