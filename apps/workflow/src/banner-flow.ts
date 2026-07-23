/**
 * The BannerFlow body — scrape the home-page rotation banners and localize
 * them (DQX-20, the first real flow on the framework).
 *
 * Steps (all declared in @hiroba/flows' BannerFlow):
 * 1. scrape     — fetch /sc/rotationbanner → sync the `banners` table
 *                 (upsert current, deactivate departed)
 * 2. languages  — load the enabled-language whitelist
 * 3. mirror     — copy each banner image into R2
 * 4. transcribe — Gemini vision reads the baked-in Japanese text
 * 5. translate  — translate the transcribed spans into each language
 * 6. localize   — bake each language's translation back into the image
 *                 (gpt-image-2), stored at l10n/<lang>/<key>
 *
 * An empty scrape early-exits with a STORED skip on the trailing five steps:
 * the run decided there was nothing to do, and the segment strip says so
 * instead of leaving five forever-pending segments.
 *
 * A banner image is just another row in the shared `images` table, so steps
 * 3–6 reuse the article pipeline's image steps verbatim — we only wrap the
 * banner URLs in synthetic image blocks to feed them. Every step is idempotent
 * (mirror skips objects already in R2, transcribe skips settled images,
 * localize skips images already done by the current model), so the hourly cron
 * only does real work for newly-appeared banners.
 *
 * Platform-free on purpose (no cloudflare:workers import): the FlowEntrypoint
 * shell lives in banner-workflow.ts, and this body runs under runFlowInline in
 * plain-node vitest.
 */

import { createDb, getEnabledLanguages } from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { type BannerFlow } from '@hiroba/flows';
import { imageKey, imageUpstreamUrl, type Block } from '@hiroba/richtext';
import { fetchRotationBanners } from '@hiroba/scraper';

import { syncBanners, type BannerListItem } from './banner-queries';
import { localizeImages } from './steps/localize-images';
import { mirrorImages } from './steps/mirror-images';
import { transcribeImages } from './steps/transcribe-images';
import { translateImageTexts } from './steps/translate-image-texts';
import type { BannerWorkflowOutput, Env } from './types';

/** The slice of the worker env the body actually touches. */
export type BannerFlowEnv = Pick<
  Env,
  'DB' | 'IMAGES_BUCKET' | 'IMAGES' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY'
>;

export async function runBannerFlow(
  f: Flow<(typeof BannerFlow)['steps']>,
  env: BannerFlowEnv,
): Promise<BannerWorkflowOutput> {
  const db = createDb(env.DB);

  // 1. Scrape the rotation page and reconcile the banners table.
  const scraped = await f.step('scrape', async () => {
    const rotation = await fetchRotationBanners();
    const items: BannerListItem[] = [];
    for (const b of rotation) {
      const key = imageKey(b.imageSrc);
      if (!key) continue; // non-mirrorable host — skip
      items.push({
        imageKey: key,
        linkUrl: b.linkUrl,
        linkTopicId: b.linkTopicId,
        altJa: b.altJa,
        sortOrder: b.order,
        publishedAt: b.publishedAt,
      });
    }
    await syncBanners(db, items);
    return items.map((i) => i.imageKey);
  });

  if (scraped.length === 0) {
    const reason = 'rotation scrape found no banners';
    f.skip('languages', reason);
    f.skip('mirror', reason);
    f.skip('transcribe', reason);
    f.skip('translate', reason);
    f.skip('localize', reason);
    return { banners: 0, mirrored: 0, transcribed: 0, localized: 0 };
  }

  // The shared image steps operate on a block tree; wrap each banner image in
  // a minimal image node so a banner image is processed like any article one.
  const blocks: Block[] = scraped.map((key) => ({
    type: 'image',
    src: imageUpstreamUrl(key),
  }));

  const languages = await f.step('languages', () => getEnabledLanguages(db));

  // 3. Mirror every banner image into R2.
  const mirror = await f.step('mirror', () =>
    mirrorImages(db, env.IMAGES_BUCKET, env.IMAGES, blocks),
  );

  // 4. Transcribe the baked-in Japanese text.
  const transcribed = await f.step('transcribe', () =>
    transcribeImages(db, blocks, env.GEMINI_API_KEY, env.IMAGES_BUCKET),
  );

  // 5. Translate the transcribed text into each language (the article
  // pipeline gets this from its translate step; banners have no body, so we
  // translate the spans directly). Localize needs these rows.
  await f.step('translate', () =>
    translateImageTexts(db, env.GEMINI_API_KEY, blocks, languages),
  );

  // 6. Bake each enabled language's translation back into the image.
  const localize = await f.step('localize', () =>
    localizeImages(
      db,
      env.IMAGES_BUCKET,
      env.IMAGES,
      env.OPENAI_API_KEY,
      blocks,
      languages,
    ),
  );

  return {
    banners: scraped.length,
    mirrored: mirror.mirrored,
    transcribed,
    localized: localize.localized,
  };
}
