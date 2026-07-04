/**
 * NewsWorkflow - Multi-step processing pipeline for news items.
 *
 * Steps:
 * 1. fetch-body - Scrape the detail page into blocks_ja and save to D1
 * 2. extract-events - LLM event extraction (RTML input) and save to D1
 * 3. translate - Whole-document RTML translation + event titles, save to D1
 *
 * Each step reads inputs from D1 and writes outputs to D1 immediately,
 * returning only minimal state (success/failure, counts).
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import { createDb } from '@hiroba/db';

import { extractAndSaveEvents } from './steps/extract-events';
import { fetchAndSaveBody } from './steps/fetch-body';
import { translateAndSave } from './steps/translate';
import type {
  Env,
  ExtractEventsResult,
  FetchBodyResult,
  NewsWorkflowOutput,
  NewsWorkflowParams,
  TranslateResult,
} from './types';

export class NewsWorkflow extends WorkflowEntrypoint<Env, NewsWorkflowParams> {
  async run(
    event: WorkflowEvent<NewsWorkflowParams>,
    step: WorkflowStep,
  ): Promise<NewsWorkflowOutput> {
    const { itemId } = event.payload;
    const db = createDb(this.env.DB);

    // Step 1: Fetch and save body content
    const fetchBodyResult = await step.do(
      'fetch-body',
      async (): Promise<FetchBodyResult> => {
        return fetchAndSaveBody(db, itemId);
      },
    );

    // If fetch failed, skip remaining steps
    if (!fetchBodyResult.success) {
      return {
        itemId,
        fetchBody: fetchBodyResult,
        extractEvents: { count: 0, eventIds: [] },
        translate: { success: false, fieldsTranslated: 0 },
      };
    }

    // Step 2: Extract events from content
    const extractEventsResult = await step.do(
      'extract-events',
      async (): Promise<ExtractEventsResult> => {
        return extractAndSaveEvents(db, this.env.GEMINI_API_KEY, itemId);
      },
    );

    // Step 3: Translate title, content, and event titles
    const translateResult = await step.do(
      'translate',
      async (): Promise<TranslateResult> => {
        return translateAndSave(
          db,
          this.env.GEMINI_API_KEY,
          itemId,
          extractEventsResult.eventIds,
        );
      },
    );

    return {
      itemId,
      fetchBody: fetchBodyResult,
      extractEvents: extractEventsResult,
      translate: translateResult,
    };
  }
}
