/**
 * PlayguideFlow body on the fast inline tier: the shared article-pipeline
 * fragments driving per-image ingest JOINS (one shared ImageIngestFlow child
 * per referenced image), the size-gated translate phase (sync and batch/poll
 * paths), the per-(image, language) localize joins, the fetch-failure skip
 * path, and full replay from memo. The real engine + hub (and the slug-key
 * attach semantics) are covered in test/playguide-flow.test.ts.
 *
 * The join seam is stubbed with inlineJoinPort — the child defs' names and
 * params are what's under test here, not the child bodies (those have their
 * own suites); block-tree image discovery runs the REAL richtext walk over
 * synthetic blocks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getEnabledLanguages, getImagesByKeys } from '@hiroba/db';
import {
  inlineJoinPort,
  runFlowInline,
  type AnyFlowDef,
  type JoinOutcome,
} from '@hiroba/flow';
import { PlayguideFlow } from '@hiroba/flows';
import type { Block } from '@hiroba/richtext';

import { getArticle, getArticleBlocks } from './article';
import { runPlayguideFlow, type PlayguideFlowEnv } from './playguide-flow';
import { purgeArticle } from './purge';
import { fetchAndSaveArticleBody } from './steps/fetch-body';
import {
  bodyMarkupSize,
  translateArticle,
  translateEventTitles,
} from './steps/translate';
import {
  pollBodyBatch,
  retrieveBodyBatch,
  submitBodyBatch,
} from './steps/translate-batch';

vi.mock('@hiroba/db', () => ({
  createDb: vi.fn(() => ({})),
  getEnabledLanguages: vi.fn(),
  ensureImageRows: vi.fn(),
  getImagesByKeys: vi.fn(),
}));

vi.mock('./article', () => ({
  getArticle: vi.fn(),
  getArticleBlocks: vi.fn(),
}));

vi.mock('./gemini', () => ({
  createGemini: vi.fn(() => ({})),
}));

vi.mock('./purge', () => ({
  purgeArticle: vi.fn(),
}));

vi.mock('./steps/fetch-body', () => ({
  fetchAndSaveArticleBody: vi.fn(),
}));

vi.mock('./steps/translate', () => ({
  bodyMarkupSize: vi.fn(),
  translateArticle: vi.fn(),
  translateEventTitles: vi.fn(),
}));

vi.mock('./steps/translate-batch', async (importOriginal) => ({
  // Spread keeps the real thresholds + isBatchTerminal; only I/O is mocked.
  ...(await importOriginal<object>()),
  submitBodyBatch: vi.fn(),
  pollBodyBatch: vi.fn(),
  retrieveBodyBatch: vi.fn(),
}));

const env = {
  DB: {},
  GEMINI_API_KEY: 'gemini-key',
} as unknown as PlayguideFlowEnv;

const SLUG = 'guide42';

// One block image (ingest + localize candidate) and one inline icon
// (mirror-only — the wider discovery walk), sharing a real /dq_resource path
// so the REAL imageKey canonicalization applies.
const IMG_KEY = 'cache.hiroba.dqx.jp/dq_resource/img/hero.png';
const ICON_KEY = 'cache.hiroba.dqx.jp/dq_resource/img/icon.png';
const BLOCKS = [
  { type: 'image', src: '/dq_resource/img/hero.png' },
  { type: 'icon', src: '/dq_resource/img/icon.png' },
] as unknown as Block[];

const IMG_ROW = { id: 7, key: IMG_KEY, textsJa: ['冒険'] };

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: 'Korean' },
];

/** The default child answer: an ingest mirrors (and transcribes when asked);
 *  a localize generation succeeds. Tests override per-child via `overrides`. */
function happyChild(def: AnyFlowDef, params: unknown): JoinOutcome {
  if (def.name === 'image-ingest') {
    const p = params as { imageKey: string; transcribe: boolean };
    return {
      status: 'complete',
      output: {
        imageKey: p.imageKey,
        mirror: 'mirrored',
        transcribed: p.transcribe,
      },
    };
  }
  const p = params as { imageKey: string; lang: string };
  return {
    status: 'complete',
    output: { imageKey: p.imageKey, lang: p.lang, outcome: 'localized' },
  };
}

/** A recording stub port: every joined child's def name + key + params land
 *  in `children`, in join order. */
function makeJoins(
  resolve: (def: AnyFlowDef, params: unknown) => JoinOutcome = happyChild,
) {
  const children: Array<{ flow: string; key: string; params: unknown }> = [];
  const spy = vi.fn((def: AnyFlowDef, params: unknown) => {
    children.push({ flow: def.name, key: def.key(params), params });
    return resolve(def, params);
  });
  return { joins: inlineJoinPort(spy), children, spy };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEnabledLanguages).mockResolvedValue(
    LANGUAGES.map((l) => ({ ...l, nativeLabel: l.label })),
  );
  vi.mocked(fetchAndSaveArticleBody).mockResolvedValue({
    success: true,
    blockCount: BLOCKS.length,
  });
  vi.mocked(getArticleBlocks).mockResolvedValue(BLOCKS);
  vi.mocked(getArticle).mockResolvedValue({
    titleJa: 'ガイド',
    blocksJa: BLOCKS,
  } as never);
  vi.mocked(getImagesByKeys).mockResolvedValue([IMG_ROW] as never);
  vi.mocked(bodyMarkupSize).mockReturnValue(100); // sync-sized by default
  vi.mocked(translateArticle).mockResolvedValue({
    success: true,
    fieldsTranslated: 6,
  });
  vi.mocked(translateEventTitles).mockResolvedValue(0);
  vi.mocked(purgeArticle).mockResolvedValue(undefined);
});

describe('playguide flow — the split pipeline', () => {
  it('runs intake → per-image ingest joins → sync translate → localize joins → purge', async () => {
    const { joins, children } = makeJoins();
    const result = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
      { joins },
    );

    expect(result.error).toBeUndefined();
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.output).toEqual({
      slug: SLUG,
      fetchBody: { success: true, blockCount: 2 },
      mirror: { mirrored: 2, skipped: 0, failed: 0 },
      transcribe: { imagesTranscribed: 1, failed: 0 },
      translate: { success: true, fieldsTranslated: 6 },
      localize: { localized: 2, skipped: 0, failed: 0 },
    });

    // One ingest JOIN per referenced image (block image AND inline icon),
    // keyed by the canonical image key so parents sharing the image attach to
    // one child run; only the block image is a transcription candidate.
    expect(children.filter((c) => c.flow === 'image-ingest')).toEqual([
      {
        flow: 'image-ingest',
        key: IMG_KEY,
        params: { imageKey: IMG_KEY, transcribe: true },
      },
      {
        flow: 'image-ingest',
        key: ICON_KEY,
        params: { imageKey: ICON_KEY, transcribe: false },
      },
    ]);
    // Localize fans out over (text-bearing image × enabled language) pairs —
    // the icon never transcribed, so only the hero generates, per language.
    expect(children.filter((c) => c.flow === 'image-localize')).toEqual([
      {
        flow: 'image-localize',
        key: `${IMG_KEY}:en`,
        params: { imageKey: IMG_KEY, lang: 'en' },
      },
      {
        flow: 'image-localize',
        key: `${IMG_KEY}:ko`,
        params: { imageKey: IMG_KEY, lang: 'ko' },
      },
    ]);
    expect(vi.mocked(getImagesByKeys)).toHaveBeenCalledWith(expect.anything(), [
      IMG_KEY,
    ]);

    // The joins ride memoized engine steps under the production names.
    const doNames = result.trace
      .filter((t) => t.type === 'do')
      .map((t) => t.name);
    expect(doNames).toContain(`images/${IMG_KEY}/start`);
    expect(doNames).toContain(`images/${ICON_KEY}/start`);
    expect(doNames).toContain('translate/plan');
    expect(doNames).toContain('translate/sync');
    expect(doNames).toContain(`localizeImages/${IMG_KEY}:en/start`);
    expect(doNames).toContain(`localizeImages/${IMG_KEY}:ko/start`);
    expect(doNames).toContain('purge');

    // Events were never declared, so nothing was skipped either — the shape
    // simply has no event steps.
    expect(result.snapshot.order).toEqual([
      'loadLanguages',
      'fetchBody',
      'images',
      'translate',
      'localizeImages',
      'purge',
    ]);
  });

  it('skips localize children for images whose text has no Japanese', async () => {
    vi.mocked(getImagesByKeys).mockResolvedValue([
      { id: 7, key: IMG_KEY, textsJa: ['LEVEL UP!'] },
    ] as never);
    const { joins, children } = makeJoins();

    const result = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
      { joins },
    );

    expect(result.error).toBeUndefined();
    // No generation children at all — nothing to bake, in any language.
    expect(children.filter((c) => c.flow === 'image-localize')).toEqual([]);
    expect(result.snapshot.steps.localizeImages).toMatchObject({
      state: 'complete',
      current: 0,
      total: 0,
    });
  });

  it('routes an oversized document to the batch path and polls it durably', async () => {
    vi.mocked(bodyMarkupSize).mockReturnValue(1_000_000);
    vi.mocked(submitBodyBatch).mockResolvedValue({
      batchName: 'batches/xyz',
    } as never);
    vi.mocked(pollBodyBatch)
      .mockResolvedValueOnce('JOB_STATE_RUNNING')
      .mockResolvedValueOnce('JOB_STATE_SUCCEEDED');
    vi.mocked(retrieveBodyBatch).mockResolvedValue(4);
    vi.mocked(translateEventTitles).mockResolvedValue(0);

    const result = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
      { joins: makeJoins().joins },
    );

    expect(result.error).toBeUndefined();
    expect(vi.mocked(translateArticle)).not.toHaveBeenCalled();
    expect(vi.mocked(pollBodyBatch)).toHaveBeenCalledTimes(2);
    expect((result.output as { translate: unknown }).translate).toEqual({
      success: true,
      fieldsTranslated: 4,
    });

    // The poll left legible engine-step names: sleep-first, then check, twice.
    const names = result.trace.map((t) => `${t.type}:${t.name}`);
    expect(names).toContain('sleep:translate/batch/wait-0');
    expect(names).toContain('do:translate/batch/check-0');
    expect(names).toContain('sleep:translate/batch/wait-1');
    expect(names).toContain('do:translate/batch/check-1');
    expect(names).toContain('do:translate/retrieve');
  });

  it('stores skips for the whole tail when the body fetch finds nothing', async () => {
    vi.mocked(fetchAndSaveArticleBody).mockResolvedValue({
      success: false,
      blockCount: 0,
    });
    const { joins, spy } = makeJoins();

    const result = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
      { joins },
    );

    expect(result.error).toBeUndefined();
    expect(result.unfinishedSteps).toEqual([]);
    for (const step of [
      'images',
      'translate',
      'localizeImages',
      'purge',
    ] as const) {
      expect(result.snapshot.steps[step].state).toBe('skipped');
    }
    expect(spy).not.toHaveBeenCalled();
    expect(vi.mocked(translateArticle)).not.toHaveBeenCalled();
    expect(vi.mocked(purgeArticle)).not.toHaveBeenCalled();
    expect((result.output as { translate: unknown }).translate).toEqual({
      success: false,
      fieldsTranslated: 0,
    });
  });

  it('replays from memo without re-running any step or re-joining any child', async () => {
    const first = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
      { joins: makeJoins().joins },
    );
    expect(first.error).toBeUndefined();
    vi.clearAllMocks();

    const { joins, spy } = makeJoins();
    const replay = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
      { memo: first.memo, joins },
    );

    expect(replay.error).toBeUndefined();
    expect(replay.output).toEqual(first.output);
    // Every step answered from memo — including the join `start` steps, which
    // is what pins a parent to the SAME child run across replays in
    // production (the memoized startAndWatch).
    expect(spy).not.toHaveBeenCalled();
    expect(vi.mocked(translateArticle)).not.toHaveBeenCalled();
    expect(vi.mocked(purgeArticle)).not.toHaveBeenCalled();
  });

  it('degrades on failed child runs instead of failing the parent', async () => {
    const { joins } = makeJoins(() => ({
      status: 'failed',
      error: 'child run failed',
    }));

    const result = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
      { joins },
    );

    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe('complete');
    expect(result.output).toMatchObject({
      mirror: { mirrored: 0, skipped: 0, failed: 2 },
      transcribe: { imagesTranscribed: 0, failed: 0 },
      localize: { localized: 0, skipped: 0, failed: 2 },
    });
  });
});
