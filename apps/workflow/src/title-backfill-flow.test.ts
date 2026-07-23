/**
 * TitleBackfillFlow body on the fast inline tier: the cursor-less
 * page-until-no-progress loop through the `open` handle (both break
 * conditions), the closure-accumulated counters surviving replay, and failure
 * propagation. The real engine + hub (and the per-language keyed dedup) are
 * covered in test/title-flows.test.ts.
 *
 * Collaborators are module-mocked (not engine-stubbed) so the real unit
 * bodies execute and their lifecycle reports fire.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runFlowInline, type FlowLogger } from '@hiroba/flow';
import { TitleBackfillFlow } from '@hiroba/flows';

import { translateTitleChunk } from './steps/translate-titles';
import {
  runTitleBackfillFlow,
  TITLE_BACKFILL_BATCH_SIZE,
  type TitleBackfillFlowEnv,
} from './title-backfill-flow';
import { getUntranslatedTitles } from './title-backfill-queries';

vi.mock('@hiroba/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('./title-backfill-queries', () => ({
  getUntranslatedTitles: vi.fn(),
}));

vi.mock('./steps/translate-titles', async (importOriginal) => ({
  // Spread keeps the real exports; only the LLM call is mocked.
  ...(await importOriginal<object>()),
  translateTitleChunk: vi.fn(),
}));

const env = {
  DB: {},
  GEMINI_API_KEY: 'test-key',
} as unknown as TitleBackfillFlowEnv;

const makeLog = (): FlowLogger & { warns: string[] } => {
  const warns: string[] = [];
  return {
    warns,
    debug: () => {},
    info: () => {},
    warn: (message: string) => warns.push(message),
    error: () => {},
  };
};

const page = (prefix: string, size: number) =>
  Array.from({ length: size }, (_, i) => ({
    id: `${prefix}${i}`,
    titleJa: `タイトル${i}`,
  }));

// News drains normally (full page, then a short one, then empty); topics make
// no progress on their first page (the model dropped every id); playguides
// are already caught up.
const NEWS_PAGES = [
  page('n', TITLE_BACKFILL_BATCH_SIZE),
  page('m', 2),
  [] as ReturnType<typeof page>,
];
const TOPIC_PAGE = page('t', 3);

beforeEach(() => {
  vi.clearAllMocks();
  const newsCalls = { count: 0 };
  vi.mocked(getUntranslatedTitles).mockImplementation(async (_db, itemType) => {
    if (itemType === 'news') return NEWS_PAGES[newsCalls.count++] ?? [];
    if (itemType === 'topic') return TOPIC_PAGE;
    return [];
  });
  vi.mocked(translateTitleChunk).mockImplementation(
    async (_db, _key, itemType, _lang, chunk) =>
      itemType === 'topic'
        ? { translated: 0, failed: chunk.length }
        : { translated: chunk.length, failed: 0 },
  );
});

describe('title backfill flow — page-until-no-progress sweeps', () => {
  it('pages each item type until its scan runs dry or stalls', async () => {
    const log = makeLog();
    const result = await runFlowInline(
      TitleBackfillFlow,
      (f, params) => runTitleBackfillFlow(f, params, env, log),
      { language: 'ko' },
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({
      language: 'ko',
      scanned: TITLE_BACKFILL_BATCH_SIZE + 2 + TOPIC_PAGE.length,
      translated: TITLE_BACKFILL_BATCH_SIZE + 2,
      failed: TOPIC_PAGE.length,
    });

    // News: full page, short page, then the empty probe. Topic: one page,
    // stopped by the no-progress guard (NOT an empty probe — the scan set
    // wouldn't shrink). Playguide: empty outright.
    const scans = vi.mocked(getUntranslatedTitles).mock.calls;
    expect(scans.filter(([, t]) => t === 'news')).toHaveLength(3);
    expect(scans.filter(([, t]) => t === 'topic')).toHaveLength(1);
    expect(scans.filter(([, t]) => t === 'playguide')).toHaveLength(1);
    expect(log.warns.join('\n')).toContain(
      'title-backfill:ko topic: no progress on 3 title(s); stopping',
    );

    // Segment truth: one indeterminate segment per item type, all complete.
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.snapshot.order).toEqual(['news', 'topic', 'playguide']);
    expect(result.snapshot.steps.news).toMatchObject({
      state: 'complete',
      current: 5, // scan-0, translate-0, scan-1, translate-1, scan-2
      total: null,
    });
    expect(result.snapshot.steps.topic).toMatchObject({
      state: 'complete',
      current: 2, // scan-0, translate-0 — no empty probe after the stall
    });
    expect(result.snapshot.steps.playguide).toMatchObject({
      state: 'complete',
      current: 1,
    });
  });

  it('a page that throws fails its segment and leaves later ones pending', async () => {
    vi.mocked(translateTitleChunk).mockRejectedValue(
      new Error('gemini unreachable'),
    );

    const result = await runFlowInline(
      TitleBackfillFlow,
      (f, params) => runTitleBackfillFlow(f, params, env, makeLog()),
      { language: 'ko' },
    );

    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain('gemini unreachable');
    expect(result.snapshot.status).toBe('failed');
    expect(result.snapshot.steps.news.state).toBe('failed');
    // Never reached — honestly pending, not skipped.
    expect(result.snapshot.steps.topic.state).toBe('pending');
    expect(result.snapshot.steps.playguide.state).toBe('pending');
  });

  it('replays entirely from memo: the counters are rebuilt, nothing re-runs', async () => {
    const first = await runFlowInline(
      TitleBackfillFlow,
      (f, params) => runTitleBackfillFlow(f, params, env, makeLog()),
      { language: 'ko' },
    );
    expect(first.error).toBeUndefined();

    vi.clearAllMocks();
    const replay = await runFlowInline(
      TitleBackfillFlow,
      (f, params) => runTitleBackfillFlow(f, params, env, makeLog()),
      { language: 'ko' },
      { memo: first.memo },
    );

    expect(replay.error).toBeUndefined();
    // The closure-accumulated counts came back identical from the memoized
    // unit returns — the "forbidden-looking" pattern holding up.
    expect(replay.output).toEqual(first.output);
    expect(vi.mocked(getUntranslatedTitles)).not.toHaveBeenCalled();
    expect(vi.mocked(translateTitleChunk)).not.toHaveBeenCalled();
    expect(replay.trace.every((entry) => entry.cached)).toBe(true);
  });
});
