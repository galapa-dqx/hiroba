/**
 * The empty-scrape early exit, on the fast inline tier: the branch must store
 * a skip for every trailing step (the hub's completeness check treats a
 * complete run with pending steps as a forgotten-step bug) and touch the
 * engine only for the scrape itself. The happy path runs against the real
 * engine + hub in test/banner-flow.test.ts.
 *
 * The scrape's collaborators are module-mocked (not engine-stubbed) so the
 * real step body executes and its lifecycle reports fire — an engine stub
 * would skip the body and leave the segment dishonestly pending.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { syncBanners } from '@hiroba/db';
import { runFlowInline } from '@hiroba/flow';
import { BannerFlow } from '@hiroba/flows';
import { fetchRotationBanners } from '@hiroba/scraper';

import { runBannerFlow, type BannerFlowEnv } from './banner-flow';

vi.mock('@hiroba/db', () => ({
  createDb: vi.fn(() => ({})),
  getEnabledLanguages: vi.fn(),
  syncBanners: vi.fn(),
}));

vi.mock('@hiroba/scraper', () => ({
  fetchRotationBanners: vi.fn(),
}));

const env = { DB: {} } as unknown as BannerFlowEnv;

const TRAILING = [
  'languages',
  'mirror',
  'transcribe',
  'translate',
  'localize',
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('banner flow — empty-scrape early exit', () => {
  it('stores a skip for the five trailing steps and reports zero counts', async () => {
    vi.mocked(fetchRotationBanners).mockResolvedValue([]);

    const result = await runFlowInline(
      BannerFlow,
      (f) => runBannerFlow(f, env),
      undefined,
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({
      banners: 0,
      mirrored: 0,
      transcribed: 0,
      localized: 0,
    });

    // The banners table was still reconciled (departed banners deactivate).
    expect(vi.mocked(syncBanners)).toHaveBeenCalledWith(expect.anything(), []);

    expect(result.snapshot.steps.scrape.state).toBe('complete');
    for (const key of TRAILING) {
      expect(result.snapshot.steps[key].state).toBe('skipped');
    }
    // Every declared step is terminal-or-skipped — the hub's completeness
    // check stays quiet on this run.
    expect(result.unfinishedSteps).toEqual([]);

    // Only the scrape reached the engine; the skips are pure reports.
    expect(result.trace).toEqual([{ type: 'do', name: 'scrape' }]);
  });
});
