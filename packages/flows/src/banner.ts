import { defineFlow, step } from '@hiroba/flow';

/**
 * The home-page rotation-banner refresh: scrape the carousel, then push every
 * banner image through the shared image pipeline (mirror → transcribe →
 * translate → localize). Six linear steps; an empty scrape stores a skip for
 * the trailing five (the run decided there was nothing to do — segment truth,
 * not a failure).
 *
 * No params: the whole rotation is always processed, so every start dedupes
 * onto the one constant key — concurrent triggers attach to the run in flight.
 */
export const BannerFlow = defineFlow({
  name: 'banner',
  key: () => 'banners',
  steps: {
    scrape: step(),
    languages: step(),
    mirror: step(),
    transcribe: step(),
    translate: step(),
    localize: step(),
  },
});
