/**
 * ImageLocalizeFlow body on the fast inline tier: one image into one
 * language — the row + label lookup feeding the generation worker, and the
 * degrade contract (failure is an outcome in the output, never a failed run).
 * The shared-child attach semantics — the point of the flow — live at the hub
 * and are covered in test/image-flows.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getImagesByKeys, getLanguageLabel } from '@hiroba/db';
import { runFlowInline } from '@hiroba/flow';
import { ImageLocalizeFlow } from '@hiroba/flows';

import {
  runImageLocalizeFlow,
  type ImageLocalizeFlowEnv,
} from './image-localize-flow';
import { localizeImageLanguage } from './steps/localize-images';

vi.mock('@hiroba/db', () => ({
  createDb: vi.fn(() => ({})),
  getImagesByKeys: vi.fn(),
  getLanguageLabel: vi.fn(),
}));

vi.mock('./steps/localize-images', () => ({
  localizeImageLanguage: vi.fn(),
}));

const env = {
  DB: {},
  IMAGES_BUCKET: {},
  IMAGES: {},
  OPENAI_API_KEY: 'openai-key',
} as unknown as ImageLocalizeFlowEnv;

const IMG_KEY = 'cache.hiroba.dqx.jp/dq_resource/img/hero.png';
const IMG_ROW = { id: 7, key: IMG_KEY, textsJa: ['冒険'] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getImagesByKeys).mockResolvedValue([IMG_ROW] as never);
  vi.mocked(getLanguageLabel).mockResolvedValue('English');
  vi.mocked(localizeImageLanguage).mockResolvedValue('localized');
});

describe('image localize flow — one shared child per (image, language)', () => {
  it('generates the localized raster for its language', async () => {
    const result = await runFlowInline(
      ImageLocalizeFlow,
      (f, params) => runImageLocalizeFlow(f, params, env),
      { imageKey: IMG_KEY, lang: 'en' },
    );

    expect(result.error).toBeUndefined();
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.output).toEqual({
      imageKey: IMG_KEY,
      lang: 'en',
      outcome: 'localized',
    });

    // Only the code travels in the params (it's the dedup key); the prompt
    // label is resolved from the whitelist here.
    expect(vi.mocked(getLanguageLabel)).toHaveBeenCalledWith(
      expect.anything(),
      'en',
    );
    expect(vi.mocked(localizeImageLanguage)).toHaveBeenCalledWith(
      expect.anything(),
      env.IMAGES_BUCKET,
      env.IMAGES,
      'openai-key',
      IMG_ROW,
      { code: 'en', label: 'English' },
    );
  });

  it('settles as a failed OUTCOME when the image row is missing', async () => {
    vi.mocked(getImagesByKeys).mockResolvedValue([] as never);

    const result = await runFlowInline(
      ImageLocalizeFlow,
      (f, params) => runImageLocalizeFlow(f, params, env),
      { imageKey: IMG_KEY, lang: 'en' },
    );

    // Degrade, don't block: the run completes and the failure is data for
    // the joined parents to count.
    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe('complete');
    expect(result.output).toEqual({
      imageKey: IMG_KEY,
      lang: 'en',
      outcome: 'failed',
    });
    expect(vi.mocked(localizeImageLanguage)).not.toHaveBeenCalled();
  });
});
