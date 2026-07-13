import { defineFlow, step } from '@hiroba/flow';

/**
 * Shared per-image ingest (DQX-27) — mirror the image into R2, then transcribe
 * its baked-in text — as a CHILD flow, keyed BY IMAGE. Articles don't run this
 * work inline anymore: each parent `mapJoin`s one child run per referenced
 * image, and because the key is the image key alone, two articles referencing
 * the same image attach to the SAME child run. The hub's keyed dedup replaces
 * the D1 image-row state machine as the cross-article coordination point (the
 * `images` rows remain — they feed the web SSE snapshot — but they are no
 * longer what stops two pipelines doing the same work twice).
 *
 * `transcribe` travels in the params but NOT in the key: whether an image is a
 * transcription candidate comes from how the discovering article references it
 * (block image vs mirror-only icon/bubble asset), which the child cannot see.
 * Concurrent parents that classify the same image differently attach to
 * whichever run started first — harmless, because ingest is idempotent per
 * image and a later run (after this one settles) fills any transcription gap.
 */
export const ImageIngestFlow = defineFlow({
  name: 'image-ingest',
  key: (params: { imageKey: string; transcribe: boolean }) => params.imageKey,
  steps: {
    mirror: step(),
    transcribe: step(),
  },
});
