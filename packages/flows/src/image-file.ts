import { defineFlow, step } from '@hiroba/flow';

/**
 * Derived-file generation for one already-written render (ImageFileFlow,
 * DQX-49): read the render's primary object, encode its derived files (the
 * full-size AVIF plus the downscaled rendition ladder, each in the source
 * format and AVIF), record them as non-primary `image_files` rows, then purge
 * the pages embedding the image so readers pick the fresh markup up
 * immediately.
 *
 * Started via the FlowHub from the admin's manual-upload route: the admin
 * worker writes the raster and its render row itself, but the follow-ups need
 * this worker's Cloudflare Images encoding and purge credentials (the same
 * reason /regenerate-image is proxied).
 *
 * Keyed by the image id — a fresh UUID per render, so every upload is its own
 * run and a stray double-trigger attaches instead of doubling the work.
 */
export const ImageFileFlow = defineFlow({
  name: 'image-file',
  // The render's id is the whole input: the ladder is backend-driven, and the
  // purge scope is read off the row.
  key: (params: { imageId: string }) => params.imageId,
  steps: { register: step(), purge: step() },
});

/**
 * The run's terminal output. Declared beside the definition so producer
 * (apps/workflow's flow body) and consumers derive from one shape.
 */
export type ImageFileOutput = {
  imageId: string;
  /** How many derived files were recorded. Zero is a normal outcome: a GIF,
   *  an SVG, or a raster whose AVIF came out no smaller keeps its primary
   *  alone and serves as a bare `<img>`. */
  files: number;
};
