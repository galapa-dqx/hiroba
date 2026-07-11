/**
 * BannerWorkflow — scrape the home-page rotation banners and localize them.
 *
 * Steps:
 * 1. scrape-banners   — fetch /sc/rotationbanner → sync the `banners` table
 *                       (upsert current, deactivate departed)
 * 2. mirror-banners   — copy each banner image into R2
 * 3. transcribe-banners — Gemini vision reads the baked-in Japanese text
 * 4. localize-banners — bake each enabled language's translation back into the
 *                       image (gpt-image-2), stored at l10n/<lang>/<key>
 *
 * A banner image is just another row in the shared `images` table, so steps 2-4
 * reuse the article pipeline's image steps verbatim — we only wrap the banner
 * URLs in synthetic image blocks to feed them. Every step is idempotent (mirror
 * skips objects already in R2, transcribe skips settled images, localize skips
 * images already done by the current model), so the hourly cron only does real
 * work for newly-appeared banners.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import {
  createDb,
  getEnabledLanguages,
  syncBanners,
  type BannerListItem,
} from '@hiroba/db';
import { imageKey, imageUpstreamUrl, type Block } from '@hiroba/richtext';
import { fetchRotationBanners } from '@hiroba/scraper';

import { createLogger, runStep } from './logger';
import { localizeImages } from './steps/localize-images';
import { mirrorImages } from './steps/mirror-images';
import { transcribeImages } from './steps/transcribe-images';
import type { BannerWorkflowOutput, BannerWorkflowParams, Env } from './types';

export class BannerWorkflow extends WorkflowEntrypoint<
  Env,
  BannerWorkflowParams
> {
  async run(
    _event: WorkflowEvent<BannerWorkflowParams>,
    step: WorkflowStep,
  ): Promise<BannerWorkflowOutput> {
    const db = createDb(this.env.DB);
    const log = createLogger(this.env, 'banners');

    // 1. Scrape the rotation page and reconcile the banners table.
    const scraped = await runStep(step, log, 'scrape-banners', async () => {
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
      return { banners: 0, mirrored: 0, transcribed: 0, localized: 0 };
    }

    // The shared image steps operate on a block tree; wrap each banner image in
    // a minimal image node so a banner image is processed like any article one.
    const blocks: Block[] = scraped.map((key) => ({
      type: 'image',
      src: imageUpstreamUrl(key),
    }));

    const languages = await runStep(step, log, 'load-languages', () =>
      getEnabledLanguages(db),
    );

    // 2. Mirror every banner image into R2.
    const mirror = await runStep(step, log, 'mirror-banners', () =>
      mirrorImages(db, this.env.IMAGES_BUCKET, blocks),
    );

    // 3. Transcribe the baked-in Japanese text.
    const transcribe = await runStep(step, log, 'transcribe-banners', () =>
      transcribeImages(
        db,
        blocks,
        this.env.GEMINI_API_KEY,
        this.env.IMAGES_BUCKET,
      ),
    );

    // 4. Bake each enabled language's translation back into the image.
    const localize = await runStep(step, log, 'localize-banners', () =>
      localizeImages(
        db,
        this.env.IMAGES_BUCKET,
        this.env.IMAGES,
        this.env.OPENAI_API_KEY,
        blocks,
        languages,
      ),
    );

    return {
      banners: scraped.length,
      mirrored: mirror.mirrored,
      transcribed: transcribe,
      localized: localize.localized,
    };
  }
}
