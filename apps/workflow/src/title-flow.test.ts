/**
 * TitleFlow body on the fast inline tier: chunk fan-out (one unit per chunk
 * per language, ids derived from memoized step returns), the empty-batch
 * skip path, failure propagation, and full replay from memo. The real engine
 * + hub (and the random-key no-attach semantics) are covered in
 * test/title-flows.test.ts.
 *
 * Collaborators are module-mocked (not engine-stubbed) so the real unit
 * bodies execute and their lifecycle reports fire.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getEnabledLanguages, getItemTitles } from '@hiroba/db';
import { runFlowInline } from '@hiroba/flow';
import { TitleFlow } from '@hiroba/flows';

import {
  TITLE_BATCH_SIZE,
  translateTitleChunk,
} from './steps/translate-titles';
import { runTitleFlow, type TitleFlowEnv } from './title-flow';

vi.mock('@hiroba/db', () => ({
  createDb: vi.fn(() => ({})),
  getItemTitles: vi.fn(),
  getEnabledLanguages: vi.fn(),
}));

vi.mock('./steps/translate-titles', async (importOriginal) => ({
  // Spread keeps the real TITLE_BATCH_SIZE; only the LLM call is mocked.
  ...(await importOriginal<object>()),
  translateTitleChunk: vi.fn(),
}));

const env = { DB: {}, GEMINI_API_KEY: 'test-key' } as unknown as TitleFlowEnv;

// One full chunk plus a remainder, so each language fans out to two units.
const ITEMS = Array.from({ length: TITLE_BATCH_SIZE + 5 }, (_, i) => ({
  id: `n${i}`,
  titleJa: `タイトル${i}`,
}));
const IDS = ITEMS.map((i) => i.id);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getItemTitles).mockResolvedValue(ITEMS);
  vi.mocked(getEnabledLanguages).mockResolvedValue([
    { code: 'en', label: 'English', nativeLabel: 'English' },
    { code: 'ko', label: 'Korean', nativeLabel: '한국어' },
  ]);
  vi.mocked(translateTitleChunk).mockImplementation(
    async (_db, _key, _type, _lang, chunk) => ({
      translated: chunk.length,
      failed: 0,
    }),
  );
});

describe('title flow — chunked translation at discovery', () => {
  it('translates one chunk per language per unit and sums the outcomes', async () => {
    const result = await runFlowInline(
      TitleFlow,
      (f, params) => runTitleFlow(f, params, env),
      { itemType: 'news', itemIds: IDS },
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({
      itemType: 'news',
      translated: ITEMS.length * 2,
      failed: 0,
    });

    // Titles were read once; each language got a full chunk and a remainder.
    expect(vi.mocked(getItemTitles)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(translateTitleChunk)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(translateTitleChunk)).toHaveBeenCalledWith(
      expect.anything(),
      'test-key',
      'news',
      'ko',
      ITEMS.slice(TITLE_BATCH_SIZE),
    );

    // Segment truth: the map knew its denominator and every unit landed.
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.snapshot.steps.translate).toMatchObject({
      state: 'complete',
      current: 4,
      total: 4,
    });
    expect(
      result.trace
        .filter(
          (t) => t.name.startsWith('translate/') && t.name !== 'translate/list',
        )
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'translate/en:0',
      'translate/en:1',
      'translate/ko:0',
      'translate/ko:1',
    ]);
  });

  it('settles every segment as skipped on an empty batch', async () => {
    const result = await runFlowInline(
      TitleFlow,
      (f, params) => runTitleFlow(f, params, env),
      { itemType: 'topic', itemIds: [] },
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({
      itemType: 'topic',
      translated: 0,
      failed: 0,
    });
    expect(vi.mocked(getItemTitles)).not.toHaveBeenCalled();
    expect(vi.mocked(translateTitleChunk)).not.toHaveBeenCalled();
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.snapshot.steps.translate.state).toBe('skipped');
  });

  it('a chunk that throws fails the translate step and the run', async () => {
    vi.mocked(translateTitleChunk).mockImplementation(
      async (_db, _key, _type, language) => {
        if (language === 'ko') throw new Error('gemini unreachable');
        return { translated: 1, failed: 0 };
      },
    );

    const result = await runFlowInline(
      TitleFlow,
      (f, params) => runTitleFlow(f, params, env),
      { itemType: 'news', itemIds: IDS },
    );

    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain('gemini unreachable');
    expect(result.snapshot.status).toBe('failed');
    expect(result.snapshot.steps.translate.state).toBe('failed');
  });

  it('replays entirely from memo: nothing re-runs, the sums come back', async () => {
    const first = await runFlowInline(
      TitleFlow,
      (f, params) => runTitleFlow(f, params, env),
      { itemType: 'news', itemIds: IDS },
    );
    expect(first.error).toBeUndefined();

    vi.clearAllMocks();
    const replay = await runFlowInline(
      TitleFlow,
      (f, params) => runTitleFlow(f, params, env),
      { itemType: 'news', itemIds: IDS },
      { memo: first.memo },
    );

    expect(replay.error).toBeUndefined();
    expect(replay.output).toEqual(first.output);
    expect(vi.mocked(getItemTitles)).not.toHaveBeenCalled();
    expect(vi.mocked(translateTitleChunk)).not.toHaveBeenCalled();
    expect(replay.trace.every((entry) => entry.cached)).toBe(true);
  });
});
