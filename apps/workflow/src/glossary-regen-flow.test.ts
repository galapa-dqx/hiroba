/**
 * GlossaryRegenFlow body on the fast inline tier: keyset pagination through the
 * `open` handle (cursor threading, both break conditions), the fan-out of
 * per-article trigger units, and — the ticket's Note — that the
 * closure-accumulated `affected` list is replay-safe because it is rebuilt from
 * memoized unit returns. The real engine + hub (and the keyed dedup) are
 * covered in test/glossary-regen-flow.test.ts.
 *
 * Collaborators are module-mocked (not engine-stubbed) so the real unit bodies
 * execute and their lifecycle reports fire.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findArticlesContainingSourcePage,
  findImagesContainingSourcePage,
} from '@hiroba/db';
import { runFlowInline } from '@hiroba/flow';
import { getFlowHub } from '@hiroba/flow/hub';
import { GlossaryRegenFlow } from '@hiroba/flows';

import {
  GLOSSARY_REGENERATE_BATCH_SIZE,
  GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE,
  runGlossaryRegenFlow,
  type GlossaryRegenFlowEnv,
} from './glossary-regen-flow';
import { retranslateImageTexts } from './steps/translate-image-texts';

vi.mock('@hiroba/db', () => ({
  createDb: vi.fn(() => ({})),
  findArticlesContainingSourcePage: vi.fn(),
  findImagesContainingSourcePage: vi.fn(),
  getEnabledLanguages: vi.fn(async () => [
    { code: 'en', label: 'English', nativeLabel: 'English' },
  ]),
}));

vi.mock('./steps/translate-image-texts', () => ({
  retranslateImageTexts: vi.fn(),
}));

// The hub entry pulls cloudflare:workers, which doesn't exist on this plain-
// node tier — and the RPC surface is exactly what this suite asserts against.
vi.mock('@hiroba/flow/hub', () => ({
  getFlowHub: vi.fn(),
}));

const TERM = 'キラーパンサー';

/** A FlowHub stub recording every start call. */
function makeEnv(opts: { failItemId?: string } = {}) {
  const calls: Array<{ flow: string; params: Record<string, unknown> }> = [];
  vi.mocked(getFlowHub).mockReturnValue({
    start: vi.fn(async (flow: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      calls.push({ flow, params: p });
      if ((p.itemId ?? p.slug) === opts.failItemId) {
        throw new Error('boom');
      }
      return { runId: 'run-1', created: true, status: 'queued' };
    }),
  } as unknown as ReturnType<typeof getFlowHub>);
  const env = {
    DB: {},
    GEMINI_API_KEY: 'test-key',
    FLOW_HUB: {},
  } as unknown as GlossaryRegenFlowEnv;
  return { env, calls };
}

// Article pages: news fills a whole page (loop continues, then breaks on the
// empty probe), topics end on a short page, playguides are empty outright.
const NEWS_PAGE = Array.from(
  { length: GLOSSARY_REGENERATE_BATCH_SIZE },
  (_, i) => `n${i}`,
);
const TOPIC_PAGE = ['t1', 't2'];

// Image pages: one full page, then a short one.
const IMAGE_PAGE_0 = Array.from(
  { length: GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE },
  (_, i) => ({ id: i + 1, textsJa: ['x'] }),
);
const IMAGE_PAGE_1 = [
  { id: GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE + 1, textsJa: ['x'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findArticlesContainingSourcePage).mockImplementation(
    async (_db, _term, itemType, afterId) => {
      if (itemType === 'news') return afterId === null ? NEWS_PAGE : [];
      if (itemType === 'topic') return afterId === null ? TOPIC_PAGE : [];
      return [];
    },
  );
  vi.mocked(findImagesContainingSourcePage).mockImplementation(
    async (_db, _term, afterId) => {
      if (afterId === null) return IMAGE_PAGE_0;
      if (afterId === GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE) return IMAGE_PAGE_1;
      return [];
    },
  );
  vi.mocked(retranslateImageTexts).mockImplementation(
    async (_db, _k, rows) => ({
      translated: rows.length,
      skipped: 0,
      failed: 0,
    }),
  );
});

describe('glossary regen flow — keyset scans + trigger fan-out', () => {
  it('pages both scans by cursor and re-triggers every affected article', async () => {
    const { env, calls } = makeEnv();
    const result = await runFlowInline(
      GlossaryRegenFlow,
      (f, params) => runGlossaryRegenFlow(f, params, env),
      { sourceText: TERM },
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({
      sourceText: TERM,
      triggered: NEWS_PAGE.length + TOPIC_PAGE.length,
      imagesRetranslated: IMAGE_PAGE_0.length + IMAGE_PAGE_1.length,
    });

    // Cursor threading: page N+1 was asked for ids/rows after page N's last.
    expect(vi.mocked(findArticlesContainingSourcePage)).toHaveBeenCalledWith(
      expect.anything(),
      TERM,
      'news',
      NEWS_PAGE[NEWS_PAGE.length - 1],
      GLOSSARY_REGENERATE_BATCH_SIZE,
    );
    expect(vi.mocked(findImagesContainingSourcePage)).toHaveBeenCalledWith(
      expect.anything(),
      TERM,
      GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE,
      GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE,
    );
    // Short pages end their loops — no extra empty probes beyond news's.
    expect(vi.mocked(findArticlesContainingSourcePage)).toHaveBeenCalledTimes(
      4, // news ×2 (full page + empty probe), topic ×1 (short), playguide ×1
    );
    expect(vi.mocked(findImagesContainingSourcePage)).toHaveBeenCalledTimes(2);

    // Every affected article was started via the hub, on the ArticleFlow
    // with its type in the params (the flow key carries the dedup identity).
    expect(calls).toHaveLength(NEWS_PAGE.length + TOPIC_PAGE.length);
    expect(calls.find((c) => c.params.itemId === 'n0')?.flow).toBe('article');
    expect(calls.find((c) => c.params.itemId === 't1')).toEqual({
      flow: 'article',
      params: { itemId: 't1', itemType: 'topic' },
    });

    // Segment truth: every declared step settled; the scans counted one unit
    // per page and the trigger map knew its denominator.
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.snapshot.steps.scanArticles).toMatchObject({
      state: 'complete',
      current: 4,
      total: null,
    });
    expect(result.snapshot.steps.retriggerArticles).toMatchObject({
      state: 'complete',
      current: NEWS_PAGE.length + TOPIC_PAGE.length,
      total: NEWS_PAGE.length + TOPIC_PAGE.length,
    });
    expect(result.snapshot.steps.retranslateImages).toMatchObject({
      state: 'complete',
      current: 4, // scan + translate units for each of the two pages
      total: null,
    });
  });

  it('replays entirely from memo: the affected list is rebuilt, nothing re-runs', async () => {
    const { env } = makeEnv();
    const first = await runFlowInline(
      GlossaryRegenFlow,
      (f, params) => runGlossaryRegenFlow(f, params, env),
      { sourceText: TERM },
    );
    expect(first.error).toBeUndefined();

    // Fresh spies + a fresh manager: a true replay touches neither D1 nor DOs.
    vi.clearAllMocks();
    const replayEnv = makeEnv();
    const replay = await runFlowInline(
      GlossaryRegenFlow,
      (f, params) => runGlossaryRegenFlow(f, params, replayEnv.env),
      { sourceText: TERM },
      { memo: first.memo },
    );

    expect(replay.error).toBeUndefined();
    // The closure-accumulated `affected` list came back identical from the
    // memoized unit returns — the "forbidden-looking" pattern holding up.
    expect(replay.output).toEqual(first.output);
    expect(vi.mocked(findArticlesContainingSourcePage)).not.toHaveBeenCalled();
    expect(vi.mocked(findImagesContainingSourcePage)).not.toHaveBeenCalled();
    expect(vi.mocked(retranslateImageTexts)).not.toHaveBeenCalled();
    expect(replayEnv.calls).toHaveLength(0);
    expect(replay.trace.every((entry) => entry.cached)).toBe(true);
  });

  it('a failed trigger fails the retrigger step instead of counting as done', async () => {
    const { env } = makeEnv({ failItemId: 't1' });
    const result = await runFlowInline(
      GlossaryRegenFlow,
      (f, params) => runGlossaryRegenFlow(f, params, env),
      { sourceText: TERM },
    );

    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain('trigger topic t1 failed: boom');
    expect(result.snapshot.status).toBe('failed');
    expect(result.snapshot.steps.retriggerArticles.state).toBe('failed');
    // The image pass was never reached — honestly pending, not skipped.
    expect(result.snapshot.steps.retranslateImages.state).toBe('pending');
  });
});
