import { defineFlow, step } from '@hiroba/flow';

/**
 * Localized raster generation for ONE image into ONE language (DQX-27) — bake
 * the translated spans into the image via gpt-image-2 — as a CHILD flow, keyed
 * by (image, language). It depends on the translated spans an ARTICLE's
 * translate step produced (whole-document in-context translation of image text
 * is the point, so translation itself stays article-scoped): parents start it
 * after their translate phase, and every other article sharing the image
 * attaches to the same child run instead of generating the raster twice.
 */
export const ImageLocalizeFlow = defineFlow({
  name: 'image-localize',
  key: (params: { imageKey: string; lang: string }) =>
    `${params.imageKey}:${params.lang}`,
  steps: {
    generate: step(),
  },
});
