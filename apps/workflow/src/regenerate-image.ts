/**
 * Synchronous single-image regeneration for the admin edit page.
 *
 * This worker holds the OpenAI key and the Images binding the admin worker
 * lacks, which is why regeneration is proxied here (a plain route since
 * DQX-26) rather than done in the admin app.
 */

import {
  createDb,
  getEnabledLanguages,
  getImageById,
  getImageTranslations,
  getImageTranslationStates,
  MANUAL_IMAGE_MODEL,
} from '@hiroba/db';
import { imageUpstreamUrl, type Block } from '@hiroba/richtext';

import { purgeImagePages } from './purge';
import { localizeImages } from './steps/localize-images';
import type { Env } from './types';

/**
 * Regenerate one image's localized raster for one language with gpt-image-2,
 * synchronously — the admin edit page awaits the fresh image. Runs the shared
 * localize step (which reads the current translated spans from D1) with
 * `force`, so it redoes an image even if it's already localized or manually
 * overridden. Bounded work: a single image × single language.
 */
export async function regenerateImage(
  env: Env,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as {
    imageId?: unknown;
    language?: unknown;
  };
  const imageId =
    typeof body.imageId === 'number' ? body.imageId : Number(body.imageId);
  const language = typeof body.language === 'string' ? body.language : '';
  if (!Number.isInteger(imageId) || !language) {
    return Response.json(
      { error: 'imageId (number) and language required' },
      { status: 400 },
    );
  }

  const db = createDb(env.DB);
  const image = await getImageById(db, imageId);
  if (!image) {
    return Response.json({ error: 'Image not found' }, { status: 404 });
  }

  // The label is what the prompt says to translate into; take it from the
  // whitelist so an admin can't regenerate into a disabled/unknown language.
  const languages = await getEnabledLanguages(db);
  const target = languages.find((l) => l.code === language);
  if (!target) {
    return Response.json(
      { error: `Language '${language}' is not enabled` },
      { status: 400 },
    );
  }

  // The shared step operates on a block tree; wrap the image in a minimal node.
  const blocks: Block[] = [{ type: 'image', src: imageUpstreamUrl(image.key) }];
  // Force past any existing (or manual) row, and stamp the result manual so —
  // like an upload — an operator's regeneration survives the nightly refresh.
  const result = await localizeImages(
    db,
    env.IMAGES_BUCKET,
    env.IMAGES,
    env.OPENAI_API_KEY,
    blocks,
    [{ code: target.code, label: target.label }],
    { force: true, model: MANUAL_IMAGE_MODEL },
  );

  // Report the url row's settled state so the client can show the new image
  // or the failure reason without a second round-trip.
  const states = await getImageTranslationStates(
    db,
    [imageId],
    language,
    'url',
  );
  const values = await getImageTranslations(db, [imageId], language, 'url');
  const state = states.get(imageId) ?? null;
  const localizedKey = values.get(imageId) ?? null;

  // The fresh render lives at a NEW versioned URL; what's stale is every
  // cached page still embedding the previous version's URL. Purge them for an
  // immediate refresh (best-effort; no-ops until purge is configured).
  if (result.localized > 0 && localizedKey) {
    await purgeImagePages(env, db, image.key, language, {
      warn: (m) => console.warn(m),
      debug: () => {},
    });
  }

  return Response.json({
    status: result.localized > 0 ? 'done' : 'failed',
    state,
    localizedKey,
  });
}
