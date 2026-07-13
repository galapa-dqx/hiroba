/**
 * PlayguideFlow body on the fast inline tier: the shared article-pipeline
 * fragments driving per-image ingest units (mirror+transcribe checkpointed
 * per image), the size-gated translate phase (sync and batch/poll paths), the
 * per-image localize units, the fetch-failure skip path, and full replay from
 * memo. The real engine + hub (and the slug-key attach semantics) are covered
 * in test/playguide-flow.test.ts.
 *
 * Collaborators are module-mocked at the per-unit worker seam (mirrorOneImage
 * etc.) so the orchestration — unit sets, ids, step names — is what's under
 * test; block-tree image discovery runs the REAL richtext walk over synthetic
 * blocks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getEnabledLanguages, getImagesByKeys } from '@hiroba/db';
import { runFlowInline } from '@hiroba/flow';
import { PlayguideFlow } from '@hiroba/flows';
import type { Block } from '@hiroba/richtext';

import { getArticle, getArticleBlocks } from './article';
import { runPlayguideFlow, type PlayguideFlowEnv } from './playguide-flow';
import { purgeArticle } from './purge';
import { fetchAndSaveArticleBody } from './steps/fetch-body';
import { localizeOneImage } from './steps/localize-images';
import { mirrorOneImage } from './steps/mirror-images';
import { transcribeOneImage } from './steps/transcribe-images';
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

vi.mock('./steps/mirror-images', () => ({
  mirrorOneImage: vi.fn(),
}));

vi.mock('./steps/transcribe-images', () => ({
  transcribeOneImage: vi.fn(),
}));

vi.mock('./steps/localize-images', () => ({
  localizeOneImage: vi.fn(),
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
  IMAGES_BUCKET: {},
  IMAGES: {},
  OPENAI_API_KEY: 'openai-key',
  GEMINI_API_KEY: 'gemini-key',
} as unknown as PlayguideFlowEnv;

const SLUG = 'guide42';

// One block image (mirror + transcribe + localize candidate) and one inline
// icon (mirror-only — the old mirror step's wider discovery walk), sharing a
// real /dq_resource path so the REAL imageKey canonicalization applies.
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
  vi.mocked(mirrorOneImage).mockResolvedValue('mirrored');
  vi.mocked(transcribeOneImage).mockResolvedValue(true);
  vi.mocked(getImagesByKeys).mockResolvedValue([IMG_ROW] as never);
  vi.mocked(localizeOneImage).mockResolvedValue({
    localized: 2,
    skipped: 0,
    failed: 0,
  });
  vi.mocked(bodyMarkupSize).mockReturnValue(100); // sync-sized by default
  vi.mocked(translateArticle).mockResolvedValue({
    success: true,
    fieldsTranslated: 6,
  });
  vi.mocked(translateEventTitles).mockResolvedValue(0);
  vi.mocked(purgeArticle).mockResolvedValue(undefined);
});

describe('playguide flow — the split pipeline', () => {
  it('runs intake → per-image units → sync translate → localize → purge', async () => {
    const result = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
    );

    expect(result.error).toBeUndefined();
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.output).toEqual({
      slug: SLUG,
      fetchBody: { success: true, blockCount: 2 },
      mirror: { mirrored: 2, skipped: 0, failed: 0 },
      transcribe: { imagesTranscribed: 1 },
      translate: { success: true, fieldsTranslated: 6 },
      localize: { localized: 2, skipped: 0, failed: 0 },
    });

    // One ingest unit per referenced image (block image AND inline icon),
    // named by the canonical image key; only the block image is a
    // transcription candidate.
    expect(vi.mocked(mirrorOneImage)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(transcribeOneImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transcribeOneImage)).toHaveBeenCalledWith(
      expect.anything(),
      IMG_KEY,
      'gemini-key',
      env.IMAGES_BUCKET,
    );
    const doNames = result.trace
      .filter((t) => t.type === 'do')
      .map((t) => t.name);
    expect(doNames).toContain(`images/${IMG_KEY}`);
    expect(doNames).toContain(`images/${ICON_KEY}`);
    expect(doNames).toContain('translate/plan');
    expect(doNames).toContain('translate/sync');
    expect(doNames).toContain(`localizeImages/${IMG_KEY}`);
    expect(doNames).toContain('purge');

    // Localize fans out over the candidate rows only; each unit bakes every
    // enabled language for its image.
    expect(vi.mocked(getImagesByKeys)).toHaveBeenCalledWith(expect.anything(), [
      IMG_KEY,
    ]);
    expect(vi.mocked(localizeOneImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localizeOneImage)).toHaveBeenCalledWith(
      expect.anything(),
      env.IMAGES_BUCKET,
      env.IMAGES,
      'openai-key',
      IMG_ROW,
      LANGUAGES.map((l) => ({ ...l, nativeLabel: l.label })),
    );

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

    const result = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
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
    expect(vi.mocked(mirrorOneImage)).not.toHaveBeenCalled();
    expect(vi.mocked(translateArticle)).not.toHaveBeenCalled();
    expect(vi.mocked(purgeArticle)).not.toHaveBeenCalled();
    expect((result.output as { translate: unknown }).translate).toEqual({
      success: false,
      fieldsTranslated: 0,
    });
  });

  it('replays from memo without re-running any unit', async () => {
    const first = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
    );
    expect(first.error).toBeUndefined();
    vi.clearAllMocks();

    const replay = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
      { memo: first.memo },
    );

    expect(replay.error).toBeUndefined();
    expect(replay.output).toEqual(first.output);
    // Every step answered from memo — the per-unit workers never ran, which
    // is the point of per-image checkpointing (a resume redoes nothing done).
    expect(vi.mocked(mirrorOneImage)).not.toHaveBeenCalled();
    expect(vi.mocked(transcribeOneImage)).not.toHaveBeenCalled();
    expect(vi.mocked(translateArticle)).not.toHaveBeenCalled();
    expect(vi.mocked(localizeOneImage)).not.toHaveBeenCalled();
    expect(vi.mocked(purgeArticle)).not.toHaveBeenCalled();
  });

  it('degrades on per-image failures instead of failing the run', async () => {
    vi.mocked(mirrorOneImage).mockResolvedValue('failed');
    vi.mocked(transcribeOneImage).mockResolvedValue(false);
    vi.mocked(localizeOneImage).mockResolvedValue({
      localized: 0,
      skipped: 0,
      failed: 2,
    });

    const result = await runFlowInline(
      PlayguideFlow,
      (f, params) => runPlayguideFlow(f, params, env),
      { slug: SLUG },
    );

    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe('complete');
    expect(result.output).toMatchObject({
      mirror: { mirrored: 0, skipped: 0, failed: 2 },
      transcribe: { imagesTranscribed: 0 },
      localize: { localized: 0, skipped: 0, failed: 2 },
    });
    // Transcription was still attempted — the loader falls back to a direct
    // CDN fetch when the mirror failed.
    expect(vi.mocked(transcribeOneImage)).toHaveBeenCalledTimes(1);
  });
});
