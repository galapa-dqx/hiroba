import { phase, step, units } from '@hiroba/flow';

/**
 * The article-pipeline step fragments (DQX-24) — the reuse mechanism between
 * PlayguideFlow and ArticleFlow (DQX-25). Fragments spread into definitions in
 * insertion order, and the shared body helpers in apps/workflow
 * (`imageAndOutputPipeline`, `translateSizeGated`) are typed against exactly
 * these shapes — any flow whose steps structurally contain a fragment can hand
 * its tracker to the fragment's helper (ArticleFlow ⊃ PlayguideFlow).
 */

/** Front matter every article-shaped flow runs first: the enabled-language
 *  whitelist read, then the detail-page scrape into `blocks_ja`. */
export const articleIntake = {
  loadLanguages: step(),
  fetchBody: step(),
};

/** One unit per referenced image — mirror into R2 + transcribe the baked-in
 *  text, checkpointed per image instead of one big step. */
export const articleImagework = {
  images: units(),
};

/** The output tail: whole-document translation (one segment wrapping the
 *  size-gated sync/batch dance), per-image localized rasters, and the edge
 *  purge of the article's detail pages. */
export const articleOutput = {
  translate: phase(),
  localizeImages: units(),
  purge: step(),
};
