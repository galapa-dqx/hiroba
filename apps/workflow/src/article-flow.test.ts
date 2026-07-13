/**
 * ArticleFlow body on the fast inline tier: what the port added on top of the
 * playguide-proven fragments — the two event steps between intake and the
 * shared tail, the extracted event ids feeding both tagging and the translate
 * phase, the image units no-oping for image-free news, and the fetch-failure
 * path storing skips for events + tail alike. The real engine + hub (and the
 * `${itemType}:${itemId}` key attach semantics) are covered in
 * test/article-flow.test.ts.
 *
 * Collaborators are module-mocked at the per-unit worker seam (mirrorOneImage
 * etc.) so the orchestration — unit sets, ids, step names — is what's under
 * test; block-tree image discovery runs the REAL richtext walk over synthetic
 * blocks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getEnabledLanguages, getImagesByKeys } from '@hiroba/db';
import { runFlowInline } from '@hiroba/flow';
import { ArticleFlow } from '@hiroba/flows';
import type { Block } from '@hiroba/richtext';

import { getArticle, getArticleBlocks } from './article';
import { runArticleFlow, type ArticleFlowEnv } from './article-flow';
import { purgeArticle } from './purge';
import { extractAndSaveEvents } from './steps/extract-events';
import { fetchAndSaveArticleBody } from './steps/fetch-body';
import { localizeOneImage } from './steps/localize-images';
import { mirrorOneImage } from './steps/mirror-images';
import { tagArticleEvents } from './steps/tag-events';
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

vi.mock('./steps/extract-events', () => ({
  extractAndSaveEvents: vi.fn(),
}));

vi.mock('./steps/tag-events', () => ({
  tagArticleEvents: vi.fn(),
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
} as unknown as ArticleFlowEnv;

const TOPIC_ID = 'a'.repeat(32);
const EVENT_IDS = ['ev1', 'ev2'];

// One block image (mirror + transcribe + localize candidate) with a real
// /dq_resource path so the REAL imageKey canonicalization applies — the topic
// shape. News bodies are text-only (below).
const IMG_KEY = 'cache.hiroba.dqx.jp/dq_resource/img/hero.png';
const TOPIC_BLOCKS = [
  { type: 'paragraph', children: ['開催期間'] },
  { type: 'image', src: '/dq_resource/img/hero.png' },
] as unknown as Block[];
const NEWS_BLOCKS = [
  { type: 'paragraph', children: ['本文のみ'] },
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
    blockCount: TOPIC_BLOCKS.length,
  });
  vi.mocked(extractAndSaveEvents).mockResolvedValue({
    count: EVENT_IDS.length,
    eventIds: EVENT_IDS,
  });
  vi.mocked(tagArticleEvents).mockResolvedValue({
    tagged: true,
    timeTags: 2,
    eventTags: 1,
    retried: false,
  });
  vi.mocked(getArticleBlocks).mockResolvedValue(TOPIC_BLOCKS);
  vi.mocked(getArticle).mockResolvedValue({
    titleJa: '記事',
    blocksJa: TOPIC_BLOCKS,
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

describe('article flow — news + topics on the shared fragments', () => {
  it('runs intake → events → per-image units → sync translate → localize → purge', async () => {
    const result = await runFlowInline(
      ArticleFlow,
      (f, params) => runArticleFlow(f, params, env),
      { itemType: 'topic', itemId: TOPIC_ID },
    );

    expect(result.error).toBeUndefined();
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.output).toEqual({
      itemId: TOPIC_ID,
      itemType: 'topic',
      fetchBody: { success: true, blockCount: 2 },
      extractEvents: { count: 2, eventIds: EVENT_IDS },
      tagEvents: { tagged: true, timeTags: 2, eventTags: 1, retried: false },
      mirror: { mirrored: 1, skipped: 0, failed: 0 },
      transcribe: { imagesTranscribed: 1 },
      translate: { success: true, fieldsTranslated: 6 },
      localize: { localized: 2, skipped: 0, failed: 0 },
    });

    // The event steps sit between intake and the shared tail, and the
    // extracted ids feed the inline tagging pass.
    expect(result.snapshot.order).toEqual([
      'loadLanguages',
      'fetchBody',
      'extractEvents',
      'tagEvents',
      'images',
      'translate',
      'localizeImages',
      'purge',
    ]);
    expect(vi.mocked(tagArticleEvents)).toHaveBeenCalledWith(
      expect.anything(),
      'gemini-key',
      'topic',
      TOPIC_ID,
      EVENT_IDS,
    );
    // …and the same ids feed the translate phase (event titles translate
    // alongside the document).
    expect(vi.mocked(translateArticle)).toHaveBeenCalledWith(
      expect.anything(),
      'gemini-key',
      'topic',
      TOPIC_ID,
      EVENT_IDS,
      LANGUAGES.map((l) => ({ ...l, nativeLabel: l.label })),
    );

    const doNames = result.trace
      .filter((t) => t.type === 'do')
      .map((t) => t.name);
    expect(doNames).toContain(`images/${IMG_KEY}`);
    expect(doNames).toContain(`localizeImages/${IMG_KEY}`);
  });

  it('no-ops the image units for an image-free news body', async () => {
    vi.mocked(getArticleBlocks).mockResolvedValue(NEWS_BLOCKS);
    vi.mocked(getArticle).mockResolvedValue({
      titleJa: 'ニュース',
      blocksJa: NEWS_BLOCKS,
    } as never);
    vi.mocked(getImagesByKeys).mockResolvedValue([] as never);

    const result = await runFlowInline(
      ArticleFlow,
      (f, params) => runArticleFlow(f, params, env),
      { itemType: 'news', itemId: 'b'.repeat(32) },
    );

    expect(result.error).toBeUndefined();
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.output).toMatchObject({
      itemType: 'news',
      mirror: { mirrored: 0, skipped: 0, failed: 0 },
      transcribe: { imagesTranscribed: 0 },
      localize: { localized: 0, skipped: 0, failed: 0 },
    });
    expect(vi.mocked(mirrorOneImage)).not.toHaveBeenCalled();
    expect(vi.mocked(localizeOneImage)).not.toHaveBeenCalled();
    // The unit steps still settle — empty sets, not eternal pendings.
    expect(result.snapshot.steps.images.state).toBe('complete');
    expect(result.snapshot.steps.localizeImages.state).toBe('complete');
    // Events still run: news carries dated announcements.
    expect(vi.mocked(extractAndSaveEvents)).toHaveBeenCalled();
  });

  it('routes an oversized document to the batch path, event titles included', async () => {
    vi.mocked(bodyMarkupSize).mockReturnValue(1_000_000);
    vi.mocked(submitBodyBatch).mockResolvedValue({
      batchName: 'batches/xyz',
    } as never);
    vi.mocked(pollBodyBatch).mockResolvedValue('JOB_STATE_SUCCEEDED');
    vi.mocked(retrieveBodyBatch).mockResolvedValue(4);
    vi.mocked(translateEventTitles).mockResolvedValue(2);

    const result = await runFlowInline(
      ArticleFlow,
      (f, params) => runArticleFlow(f, params, env),
      { itemType: 'topic', itemId: TOPIC_ID },
    );

    expect(result.error).toBeUndefined();
    expect(vi.mocked(translateArticle)).not.toHaveBeenCalled();
    // The event titles ride the batch retrieve step, with the extracted ids.
    expect(vi.mocked(translateEventTitles)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      EVENT_IDS,
      LANGUAGES.map((l) => ({ ...l, nativeLabel: l.label })),
    );
    expect((result.output as { translate: unknown }).translate).toEqual({
      success: true,
      fieldsTranslated: 6,
    });
  });

  it('stores skips for events and the whole tail when the body fetch finds nothing', async () => {
    vi.mocked(fetchAndSaveArticleBody).mockResolvedValue({
      success: false,
      blockCount: 0,
    });

    const result = await runFlowInline(
      ArticleFlow,
      (f, params) => runArticleFlow(f, params, env),
      { itemType: 'news', itemId: 'b'.repeat(32) },
    );

    expect(result.error).toBeUndefined();
    expect(result.unfinishedSteps).toEqual([]);
    for (const step of [
      'extractEvents',
      'tagEvents',
      'images',
      'translate',
      'localizeImages',
      'purge',
    ] as const) {
      expect(result.snapshot.steps[step].state).toBe('skipped');
    }
    expect(vi.mocked(extractAndSaveEvents)).not.toHaveBeenCalled();
    expect(vi.mocked(translateArticle)).not.toHaveBeenCalled();
    expect(vi.mocked(purgeArticle)).not.toHaveBeenCalled();
  });

  it('replays from memo without re-running any step', async () => {
    const first = await runFlowInline(
      ArticleFlow,
      (f, params) => runArticleFlow(f, params, env),
      { itemType: 'topic', itemId: TOPIC_ID },
    );
    expect(first.error).toBeUndefined();
    vi.clearAllMocks();

    const replay = await runFlowInline(
      ArticleFlow,
      (f, params) => runArticleFlow(f, params, env),
      { itemType: 'topic', itemId: TOPIC_ID },
      { memo: first.memo },
    );

    expect(replay.error).toBeUndefined();
    expect(replay.output).toEqual(first.output);
    expect(vi.mocked(extractAndSaveEvents)).not.toHaveBeenCalled();
    expect(vi.mocked(tagArticleEvents)).not.toHaveBeenCalled();
    expect(vi.mocked(mirrorOneImage)).not.toHaveBeenCalled();
    expect(vi.mocked(translateArticle)).not.toHaveBeenCalled();
    expect(vi.mocked(localizeOneImage)).not.toHaveBeenCalled();
    expect(vi.mocked(purgeArticle)).not.toHaveBeenCalled();
  });
});
