/**
 * TopicsWorkflow - Multi-step processing pipeline for rich-text topics.
 *
 * Steps (each reads/writes D1, returns minimal state):
 * 1. fetch-body        - scrape + parse the detail page → blocks_ja
 * 2. mirror-images     - copy every referenced image into R2 (self-hosted)
 * 3. transcribe-images - Gemini vision reads baked-in image text → blocks_ja (again)
 * 4. translate         - whole-document JA→EN → translations (title + content)
 * 5. localize-images   - bake the EN translations back into text-bearing images
 *
 * Mirroring runs before transcription so transcribe reads bytes from R2 (one CDN
 * fetch per image ever). Transcription must land in blocks_ja before translation
 * so the image text is translated in-context (via <figure>). Localization runs
 * last: it needs the EN spans the translate step produced.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { Temporal } from 'temporal-polyfill';

import type { Block } from '@hiroba/richtext';
import { createDb, getTopic, upsertTopic } from '@hiroba/db';
import { fetchTopicBody } from '@hiroba/scraper';

import { localizeImages, type LocalizeResult } from './steps/localize-images';
import { mirrorImages, type MirrorResult } from './steps/mirror-images';
import { transcribeImages } from './steps/transcribe-images';
import { translateTopic } from './steps/translate-topic';
import type {
  Env,
  FetchTopicResult,
  TopicsWorkflowOutput,
  TopicsWorkflowParams,
  TranscribeResult,
  TranslateResult,
} from './types';

export class TopicsWorkflow extends WorkflowEntrypoint<Env, TopicsWorkflowParams> {
  async run(event: WorkflowEvent<TopicsWorkflowParams>, step: WorkflowStep): Promise<TopicsWorkflowOutput> {
    const { itemId } = event.payload;
    const db = createDb(this.env.DB);

    // Step 1: fetch + parse the detail page → blocks_ja
    const fetchBody = await step.do('fetch-body', async (): Promise<FetchTopicResult> => {
      const { titleJa, blocks } = await fetchTopicBody(itemId);
      const existing = await getTopic(db, itemId);
      await upsertTopic(db, {
        id: itemId,
        titleJa,
        // Keep an accurate date if the row was seeded by list scraping; otherwise
        // stamp now (the topics list scraper can backfill real dates later).
        publishedAt: existing?.publishedAt ?? Temporal.Now.instant(),
        blocksJa: blocks,
        bodyFetchedAt: Temporal.Now.instant(),
      });
      return { success: blocks.length > 0, blockCount: blocks.length };
    });

    if (!fetchBody.success) {
      return {
        itemId,
        fetchBody,
        mirror: { mirrored: 0, skipped: 0, failed: 0 },
        transcribe: { imagesTranscribed: 0 },
        translate: { success: false, fieldsTranslated: 0 },
        localize: { localized: 0, skipped: 0, failed: 0 },
      };
    }

    // Step 2: mirror every referenced image into R2 (self-hosted, cheap to serve)
    const mirror = await step.do('mirror-images', async (): Promise<MirrorResult> => {
      const topic = await getTopic(db, itemId);
      const blocks = (topic?.blocksJa ?? []) as Block[];
      return mirrorImages(this.env.IMAGES, blocks);
    });

    // Step 3: transcribe baked-in image text into the `images` table (deduped by
    // key across topics). Reads bytes from the R2 mirror, so it doesn't re-hit
    // the CDN.
    const transcribe = await step.do('transcribe-images', async (): Promise<TranscribeResult> => {
      const topic = await getTopic(db, itemId);
      const blocks = (topic?.blocksJa ?? []) as Block[];
      const imagesTranscribed = await transcribeImages(db, blocks, this.env.GEMINI_API_KEY, this.env.IMAGES);
      return { imagesTranscribed };
    });

    // Step 4: translate the (now transcribed) document → translations
    const translate = await step.do('translate', async (): Promise<TranslateResult> => {
      return translateTopic(db, this.env.GEMINI_API_KEY, itemId);
    });

    // Step 5: bake the EN translations back into text-bearing images (gpt-image-2).
    // Reads texts_ja + the EN spans from the images/translations tables, so it
    // just needs the topic's block tree to know which images it references.
    const localize = await step.do('localize-images', async (): Promise<LocalizeResult> => {
      if (!translate.success) return { localized: 0, skipped: 0, failed: 0 };
      const topic = await getTopic(db, itemId);
      const blocks = (topic?.blocksJa ?? []) as Block[];
      return localizeImages(db, this.env.IMAGES, this.env.OPENAI_API_KEY, blocks);
    });

    return { itemId, fetchBody, mirror, transcribe, translate, localize };
  }
}
