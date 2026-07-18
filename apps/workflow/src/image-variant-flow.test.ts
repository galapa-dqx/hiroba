/**
 * ImageVariantFlow body on the fast inline tier: register → purge for one
 * stored render, and the degrade contract — a vanished object registers
 * nothing but still purges (the url row has already flipped, so cached pages
 * reference the previous render either way).
 *
 * Collaborators are module-mocked at the registerImageSources / purge seams.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runFlowInline } from '@hiroba/flow';
import { ImageVariantFlow } from '@hiroba/flows';

import { registerImageSources } from './image-sources';
import {
  runImageVariantFlow,
  type ImageVariantFlowEnv,
} from './image-variant-flow';
import { purgeImagePages } from './purge';

vi.mock('@hiroba/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('./image-sources', () => ({
  registerImageSources: vi.fn(),
}));

vi.mock('./purge', () => ({
  purgeImagePages: vi.fn(),
}));

const RENDER_KEY = 'l10n/en/v123/cache.hiroba.dqx.jp/dq_resource/img/a.png';
const PARAMS = {
  key: RENDER_KEY,
  imageKey: 'cache.hiroba.dqx.jp/dq_resource/img/a.jpg',
  language: 'en',
};

const envWith = (object: unknown) =>
  ({
    DB: {},
    IMAGES: {},
    IMAGES_BUCKET: { get: vi.fn(async () => object) },
  }) as unknown as ImageVariantFlowEnv;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('image render flow', () => {
  it('registers the render (with its stored metadata) then purges its pages', async () => {
    const env = envWith({
      arrayBuffer: async () => new ArrayBuffer(8),
      httpMetadata: { contentType: 'image/png', cacheControl: 'cc' },
    });
    const { output } = await runFlowInline(
      ImageVariantFlow,
      (f, params) => runImageVariantFlow(f, params, env),
      PARAMS,
    );

    expect(output).toEqual({ key: RENDER_KEY, registered: true });
    expect(registerImageSources).toHaveBeenCalledWith(
      expect.anything(),
      env.IMAGES,
      env.IMAGES_BUCKET,
      RENDER_KEY,
      expect.any(Uint8Array),
      'cc',
      { fallbackMime: 'image/png', sizes: undefined },
    );
    expect(purgeImagePages).toHaveBeenCalledWith(
      env,
      expect.anything(),
      PARAMS.imageKey,
      'en',
    );
  });

  it('still purges when the object has vanished, registering nothing', async () => {
    const env = envWith(null);
    const { output } = await runFlowInline(
      ImageVariantFlow,
      (f, params) => runImageVariantFlow(f, params, env),
      PARAMS,
    );

    expect(output).toEqual({ key: RENDER_KEY, registered: false });
    expect(registerImageSources).not.toHaveBeenCalled();
    expect(purgeImagePages).toHaveBeenCalled();
  });
});
