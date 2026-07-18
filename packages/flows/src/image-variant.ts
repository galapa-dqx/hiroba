import { defineFlow, step } from '@hiroba/flow';
import type { FitSize } from '@hiroba/shared';

/**
 * Variant generation for one stored render (ImageVariantFlow): measure the
 * object, encode its variants (full-size AVIF, plus fit-inside renditions in
 * the source format + AVIF for any requested `sizes`), record the group's
 * image_sources rows, then purge the pages embedding the image so readers
 * pick the fresh markup up immediately. Started via the FlowHub from the
 * admin's manual-upload route — the admin worker writes the raster to the
 * shared bucket itself but lacks the Cloudflare Images binding and purge
 * credentials, so both follow-ups run here (the same reason
 * /regenerate-image is proxied).
 *
 * Keyed by the render's R2 key: versioned keys are unique per render, so
 * every upload is a fresh run, and a stray double-trigger for the same
 * render attaches instead of doubling the work.
 */
export const ImageVariantFlow = defineFlow({
  name: 'image-variant',
  // `imageKey` + `language` scope the page purge (the versioned render key
  // isn't reversible to them) and `sizes` the renditions; only `key` is the
  // dedup identity.
  key: (params: {
    key: string;
    imageKey: string;
    language: string;
    sizes?: FitSize[];
  }) => params.key,
  steps: { register: step(), purge: step() },
});

/**
 * The run's terminal output. Declared beside the definition so producer
 * (apps/workflow's flow body) and consumers derive from one shape.
 */
export type ImageVariantOutput = {
  key: string;
  /** False when the object had vanished — nothing recorded, pages purged
   *  anyway (they may still reference the previous render's URL). */
  registered: boolean;
};
