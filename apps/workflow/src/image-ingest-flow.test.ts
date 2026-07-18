/**
 * ImageIngestFlow body on the fast inline tier: the mirror → transcribe
 * sequence over one image, the stored skip for mirror-only assets, and the
 * degrade contract (the step workers report failure through their returns and
 * D1 writes, never throws). The shared-child attach semantics — the point of
 * the flow — live at the hub and are covered in test/image-flows.test.ts.
 *
 * Collaborators are module-mocked at the per-image worker seam
 * (mirrorOneImage / transcribeOneImage), same seam the parent flows mocked
 * when this work ran inline in their bodies.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureImageSourceRows } from '@hiroba/db';
import { runFlowInline } from '@hiroba/flow';
import { ImageIngestFlow } from '@hiroba/flows';

import {
  runImageIngestFlow,
  type ImageIngestFlowEnv,
} from './image-ingest-flow';
import { mirrorOneImage } from './steps/mirror-images';
import { transcribeOneImage } from './steps/transcribe-images';

vi.mock('@hiroba/db', () => ({
  createDb: vi.fn(() => ({})),
  ensureImageSourceRows: vi.fn(),
}));

vi.mock('./steps/mirror-images', () => ({
  mirrorOneImage: vi.fn(),
}));

vi.mock('./steps/transcribe-images', () => ({
  transcribeOneImage: vi.fn(),
}));

const env = {
  DB: {},
  IMAGES_BUCKET: {},
  IMAGES: {},
  GEMINI_API_KEY: 'gemini-key',
} as unknown as ImageIngestFlowEnv;

const IMG_KEY = 'cache.hiroba.dqx.jp/dq_resource/img/hero.png';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mirrorOneImage).mockResolvedValue('mirrored');
  vi.mocked(transcribeOneImage).mockResolvedValue('transcribed');
});

describe('image ingest flow — one shared child per image', () => {
  it('mirrors then transcribes a candidate image', async () => {
    const result = await runFlowInline(
      ImageIngestFlow,
      (f, params) => runImageIngestFlow(f, params, env),
      { imageKey: IMG_KEY, transcribe: true },
    );

    expect(result.error).toBeUndefined();
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.output).toEqual({
      imageKey: IMG_KEY,
      mirror: 'mirrored',
      transcribed: true,
      transcribeFailed: false,
    });
    expect(result.snapshot.order).toEqual(['mirror', 'transcribe']);

    // Self-contained discovery: the child ensures its own row, whichever
    // parent started it.
    expect(vi.mocked(ensureImageSourceRows)).toHaveBeenCalledWith(
      expect.anything(),
      [IMG_KEY],
    );
    expect(vi.mocked(transcribeOneImage)).toHaveBeenCalledWith(
      expect.anything(),
      IMG_KEY,
      'gemini-key',
      env.IMAGES_BUCKET,
    );
  });

  it('stores a skip for mirror-only assets instead of transcribing', async () => {
    const result = await runFlowInline(
      ImageIngestFlow,
      (f, params) => runImageIngestFlow(f, params, env),
      { imageKey: IMG_KEY, transcribe: false },
    );

    expect(result.error).toBeUndefined();
    expect(result.unfinishedSteps).toEqual([]);
    expect(result.output).toEqual({
      imageKey: IMG_KEY,
      mirror: 'mirrored',
      transcribed: false,
      transcribeFailed: false,
    });
    expect(result.snapshot.steps.transcribe.state).toBe('skipped');
    expect(vi.mocked(transcribeOneImage)).not.toHaveBeenCalled();
  });

  it('still transcribes when the mirror failed (CDN fallback), reporting the degrade', async () => {
    vi.mocked(mirrorOneImage).mockResolvedValue('failed');
    vi.mocked(transcribeOneImage).mockResolvedValue('failed');

    const result = await runFlowInline(
      ImageIngestFlow,
      (f, params) => runImageIngestFlow(f, params, env),
      { imageKey: IMG_KEY, transcribe: true },
    );

    // The run COMPLETES — a bad image degrades, never fails; the outcome
    // travels in the output for the joined parents to count.
    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe('complete');
    expect(result.output).toEqual({
      imageKey: IMG_KEY,
      mirror: 'failed',
      transcribed: false,
      transcribeFailed: true,
    });
    expect(vi.mocked(transcribeOneImage)).toHaveBeenCalledTimes(1);
  });
});
