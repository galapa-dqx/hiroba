/**
 * GlossaryRegenFlow body on the fast inline tier: keyset pagination through the
 * `open` handle (cursor threading, both break conditions), the fan-out of
 * per-article JOINS (DQX-27 — each unit awaits its child run's terminal state,
 * with settled semantics), and — the ticket's Note — that the
 * closure-accumulated `affected` list is replay-safe because it is rebuilt from
 * memoized unit returns. The real engine + hub (and the keyed dedup) are
 * covered in test/glossary-regen-flow.test.ts.
 *
 * Collaborators are module-mocked (not engine-stubbed) so the real unit bodies
 * execute and their lifecycle reports fire; the join seam is stubbed with
 * inlineJoinPort.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findArticlesContainingSourcePage,
  findImagesContainingSourcePage,
} from '@hiroba/db';
import {
  inlineJoinPort,
  runFlowInline,
  type AnyFlowDef,
  type JoinOutcome,
} from '@hiroba/flow';
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

const TERM = 'キラーパンサー';

const env = {
  DB: {},
  GEMINI_API_KEY: 'test-key',
} as unknown as GlossaryRegenFlowEnv;

/** A recording stub port: each joined article child completes (or fails, for
 *  ids in `failIds`) and its flow + params land in `children`. */
function makeJoins(opts: { failIds?: string[] } = {}) {
  const children: Array<{ flow: string; params: Record<string, unknown> }> = [];
  const spy = vi.fn((def: AnyFlowDef, params: unknown): JoinOutcome => {
    const p = params as Record<string, unknown>;
    children.push({ flow: def.name, params: p });
    if (opts.failIds?.includes(String(p.itemId ?? p.slug))) {
      return { status: 'failed', error: 'boom' };
    }
    return { status: 'complete', output: { itemId: p.itemId ?? p.slug } };
  });
  return { joins: inlineJoinPort(spy), children, spy };
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

describe('glossary regen flow — keyset scans + joined re-runs', () => {
  it('pages both scans by cursor and joins every affected article as a child run', async () => {
    const { joins, children } = makeJoins();
    const result = await runFlowInline(
      GlossaryRegenFlow,
      (f, params) => runGlossaryRegenFlow(f, params, env),
      { sourceText: TERM },
      { joins },
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({
      sourceText: TERM,
      triggered: NEWS_PAGE.length + TOPIC_PAGE.length,
      retriggerFailed: 0,
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

    // Every affected article was JOINED (not fire-and-forgotten) on the
    // ArticleFlow with its type in the params — the flow key carries the
    // dedup identity, so an in-flight run is attached to.
    expect(children).toHaveLength(NEWS_PAGE.length + TOPIC_PAGE.length);
    expect(children.find((c) => c.params.itemId === 'n0')?.flow).toBe(
      'article',
    );
    expect(children.find((c) => c.params.itemId === 't1')).toEqual({
      flow: 'article',
      params: { itemId: 't1', itemType: 'topic' },
    });

    // Segment truth: every declared step settled; the scans counted one unit
    // per page and the join map's units ARE the child runs.
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
    const first = await runFlowInline(
      GlossaryRegenFlow,
      (f, params) => runGlossaryRegenFlow(f, params, env),
      { sourceText: TERM },
      { joins: makeJoins().joins },
    );
    expect(first.error).toBeUndefined();

    // Fresh spies + a fresh port: a true replay touches neither D1 nor the hub.
    vi.clearAllMocks();
    const { joins, spy } = makeJoins();
    const replay = await runFlowInline(
      GlossaryRegenFlow,
      (f, params) => runGlossaryRegenFlow(f, params, env),
      { sourceText: TERM },
      { memo: first.memo, joins },
    );

    expect(replay.error).toBeUndefined();
    // The closure-accumulated `affected` list came back identical from the
    // memoized unit returns — the "forbidden-looking" pattern holding up.
    expect(replay.output).toEqual(first.output);
    expect(vi.mocked(findArticlesContainingSourcePage)).not.toHaveBeenCalled();
    expect(vi.mocked(findImagesContainingSourcePage)).not.toHaveBeenCalled();
    expect(vi.mocked(retranslateImageTexts)).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(replay.trace.every((entry) => entry.cached)).toBe(true);
  });

  it('counts a failed child run instead of blocking the rest (settled semantics)', async () => {
    const { joins, children } = makeJoins({ failIds: ['t1'] });
    const result = await runFlowInline(
      GlossaryRegenFlow,
      (f, params) => runGlossaryRegenFlow(f, params, env),
      { sourceText: TERM },
      { joins },
    );

    // The run COMPLETES: one degraded article must not sink a 100-article
    // regeneration — but the failure is loud in the output.
    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe('complete');
    expect(result.output).toMatchObject({
      triggered: NEWS_PAGE.length + TOPIC_PAGE.length,
      retriggerFailed: 1,
    });
    // Every other child was still joined; the image pass still ran.
    expect(children).toHaveLength(NEWS_PAGE.length + TOPIC_PAGE.length);
    expect(result.snapshot.steps.retriggerArticles.state).toBe('complete');
    expect(result.snapshot.steps.retranslateImages.state).toBe('complete');
  });
});
