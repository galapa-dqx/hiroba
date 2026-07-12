/**
 * Test-only worker entry for the pool-workers integration tier. Exports the
 * REAL hub mount and the ported flow workflows — not the full src/index.ts,
 * whose router, crons, and Sentry wrapper are noise here.
 */

export { FlowHub } from '../../src/flow-hub';
export { BannerWorkflow } from '../../src/banner-workflow';
export { GlossaryRegenerateWorkflow } from '../../src/glossary-regenerate-workflow';

export default {
  fetch: (): Response => new Response('workflow test fixture'),
};
