/**
 * Test-only worker entry for the pool-workers integration tier. Exports the
 * REAL hub mount and the ported flow workflows — not the full src/index.ts,
 * whose router, crons, and Sentry wrapper are noise here.
 */

export { FlowHub } from '../../src/flow-hub';
export { ArticleWorkflow } from '../../src/article-workflow';
export { BannerWorkflow } from '../../src/banner-workflow';
export { GlossaryRegenerateWorkflow } from '../../src/glossary-regenerate-workflow';
export { TitleWorkflow } from '../../src/title-workflow';
export { TitleBackfillWorkflow } from '../../src/title-backfill-workflow';
export { NewsBackfillWorkflow } from '../../src/news-backfill-workflow';
export { PlayguideWorkflow } from '../../src/playguide-workflow';

export default {
  fetch: (): Response => new Response('workflow test fixture'),
};
